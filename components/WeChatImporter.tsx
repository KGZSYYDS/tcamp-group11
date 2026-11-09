"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { extractFromChats, dedupeItems, type ChatFile } from "@/lib/chat-extract";
import { loadPersonal, mergePersonal, savePersonal, type PersonalItem } from "@/lib/local-store";
import { normalizeWeChatPaste } from "@/lib/wechat-paste";
import WeChatSetup, { type WeFlowStatus } from "./WeChatSetup";

/**
 * 「导入微信消息」—— 默认路径是**直接读本机微信**，不是让用户自己复制。
 *
 * 之前要求用户「长按多选 → 复制 → 粘贴」，等于把最麻烦的一步丢给用户，
 * 产品上讲不通：用户要的是结果，不是操作教程。
 *
 * 现在的分工：
 *   - 自动：网页跑在本机时，服务端直接调 WeFlow 读微信库，导出 → 抽取 → 返回事项。
 *           用户只勾群、点一下。原始消息在临时目录里，处理完立即删。
 *   - 手动：网页部署在云端时（后面没有微信库），或用户只想导一两条，保留粘贴/选文件。
 *
 * 隐私：两条路都不把聊天正文送出这台电脑。自动路径的「服务端」就是 localhost。
 */

interface Props {
  /** 写入本机后通知外层刷新统计 */
  onImported: (items: PersonalItem[], added: number) => void;
}

interface Group {
  id: string;
  name: string;
  score: number;
}

interface Status extends WeFlowStatus {}

interface ScanStat {
  name: string;
  messages: number;
  hinted: number;
  items: number;
  error?: string;
}

interface PickStat {
  name: string;
  messages: number;
  error?: string;
}

const ACCEPT = /\.(json|txt|md|log)$/i;
const RANGES = [3, 7, 14, 30];

export default function WeChatImporter({ onImported }: Props) {
  const [tab, setTab] = useState<"auto" | "manual">("auto");
  const [agreed, setAgreed] = useState(false);

  // ---- 自动通道 ----
  const [status, setStatus] = useState<Status | null>(null);
  const [statusBusy, setStatusBusy] = useState(true);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsBusy, setGroupsBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [days, setDays] = useState(7);
  const [scanning, setScanning] = useState(false);
  const [stats, setStats] = useState<ScanStat[]>([]);
  const [scannedTotal, setScannedTotal] = useState<{ scanned: number; hinted: number } | null>(null);

  // ---- 手动通道 ----
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [files, setFiles] = useState<PickStat[]>([]);
  const [paste, setPaste] = useState("");
  const [pasteInfo, setPasteInfo] = useState("");

  // ---- 共用 ----
  const [items, setItems] = useState<PersonalItem[]>([]);
  const [added, setAdded] = useState<number | null>(null);
  const [error, setError] = useState("");

  const dirRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const isLocalHost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);

  /** 写入本机，返回新增条数 */
  const commit = useCallback(
    (incoming: PersonalItem[], label: string) => {
      const deduped = dedupeItems(incoming);
      setItems(deduped);
      if (!deduped.length) {
        setAdded(0);
        return 0;
      }
      const prev = loadPersonal()?.events || [];
      const merged = mergePersonal(prev, deduped);
      savePersonal({
        format: "szu-calendar-personal",
        version: 1,
        events: merged,
        importedAt: new Date().toISOString(),
        fileName: label.slice(0, 120),
      });
      const n = merged.length - prev.length;
      setAdded(n);
      onImported(deduped, n);
      return n;
    },
    [onImported]
  );

  // ---------- 自动通道：探测 → 拉群 ----------

  const loadGroups = useCallback(async () => {
    setGroupsBusy(true);
    try {
      const r = await fetch("/api/wechat/groups", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "读取群列表失败");
      const list: Group[] = j.groups || [];
      setGroups(list);
      // 默认勾上最像通知群的几个，用户不用在 200 多个群里翻
      const hot = list.filter((g) => g.score >= 3).slice(0, 6);
      setSelected(new Set((hot.length ? hot : list.slice(0, 1)).map((g) => g.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取群列表失败");
    } finally {
      setGroupsBusy(false);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setStatusBusy(true);
    setError("");
    try {
      const r = await fetch("/api/wechat/status", { cache: "no-store" });
      const j = (await r.json()) as Status;
      setStatus(j);
      if (j.available && j.connected) await loadGroups();
    } catch {
      setStatus({
        available: false,
        connected: false,
        version: null,
        accountHint: null,
        stage: "no-exe",
        exePath: null,
        wechatDirs: [],
        configured: false,
        error: "连不上本地服务",
      });
    } finally {
      setStatusBusy(false);
    }
  }, [loadGroups]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  function toggleGroup(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function scan() {
    if (!agreed) {
      setError("先勾选下面的授权项");
      return;
    }
    const picked = groups.filter((g) => selected.has(g.id));
    if (!picked.length) {
      setError("至少选一个群");
      return;
    }
    setScanning(true);
    setError("");
    setStats([]);
    setScannedTotal(null);
    setProgress("");
    setItems([]);
    setAdded(null);
    try {
      const r = await fetch("/api/wechat/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: picked.map((g) => ({ id: g.id, name: g.name })), days }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "扫描失败");

      setStats(j.stats || []);
      setScannedTotal({ scanned: j.scanned || 0, hinted: j.hinted || 0 });
      commit(j.items || [], picked.map((g) => g.name).join("、"));

      if (!(j.items || []).length) {
        setError(
          `扫了 ${j.scanned || 0} 条消息，没找到带日期的安排。把时间范围放宽到 14 天，或多勾几个群再试。`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "扫描失败");
    } finally {
      setScanning(false);
    }
  }

  // ---------- 手动通道 ----------

  async function run(chatFiles: ChatFile[]) {
    if (chatFiles.length === 0) {
      setError("没有可读的内容");
      return;
    }
    setBusy(true);
    setError("");
    setProgress("正在本地解析…");
    try {
      await new Promise((r) => setTimeout(r, 30));
      const r = extractFromChats(chatFiles);
      setFiles(r.files);
      commit(r.items, chatFiles.map((f) => f.name).join(", "));
      if (r.items.length === 0) {
        setError(
          "没认出带日期的安排。检查一下内容里有没有「几号几点」这类说法；也可以只粘关键那条通知再试。"
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败");
    } finally {
      setBusy(false);
      setProgress("");
      if (dirRef.current) dirRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function runPaste() {
    if (!agreed) {
      setError("先勾选下面的同意项");
      return;
    }
    const raw = paste.trim();
    if (raw.length < 4) {
      setError("先粘贴一段聊天记录");
      return;
    }
    const n = normalizeWeChatPaste(raw);
    setPasteInfo(
      n.structured
        ? `识别出 ${n.messages} 条消息（含发送人和时间）`
        : "没识别出「昵称 + 时间」的结构，已按整段文字处理"
    );
    void run([{ name: "粘贴的内容", text: n.text, lastModified: Date.now() }]);
  }

  async function pickDir() {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (!picker) {
      dirRef.current?.click();
      return;
    }
    try {
      const dir = await picker({ mode: "read", id: "szu-chat" });
      const picked: ChatFile[] = [];
      setProgress("正在读取目录…");
      // @ts-expect-error 目录句柄的 async 迭代在 lib.dom 里还没补全
      for await (const entry of dir.values()) {
        if (entry.kind !== "file" || !ACCEPT.test(entry.name)) continue;
        const f = await entry.getFile();
        if (f.size > 40 * 1024 * 1024) continue;
        picked.push({ name: entry.name, text: await f.text(), lastModified: f.lastModified });
      }
      await run(picked);
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError") setError(e.message);
      setProgress("");
    }
  }

  function onPickInput(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files || []).filter((f) => ACCEPT.test(f.name));
    if (!list.length) {
      setError("选中的文件里没有 .json / .txt");
      return;
    }
    Promise.all(
      list.map(async (f) => ({ name: f.name, text: await f.text(), lastModified: f.lastModified }))
    ).then(run);
  }

  // ---------- 渲染 ----------

  const filtered = query
    ? groups.filter((g) => g.name.toLowerCase().includes(query.trim().toLowerCase()))
    : groups;
  const ready = status?.available && status.connected;

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm sm:col-span-3">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">导入微信消息</h2>
        <div className="flex rounded-lg bg-gray-100 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setTab("auto")}
            className={`rounded-md px-2.5 py-1 font-medium transition ${
              tab === "auto" ? "bg-white text-gray-800 shadow-sm" : "text-gray-500"
            }`}
          >
            直接扫描
          </button>
          <button
            type="button"
            onClick={() => setTab("manual")}
            className={`rounded-md px-2.5 py-1 font-medium transition ${
              tab === "manual" ? "bg-white text-gray-800 shadow-sm" : "text-gray-500"
            }`}
          >
            手动粘贴
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs leading-relaxed text-gray-400">
        把群里的「几号几点开会」「哪天前交表」变成日历事项。
        {tab === "auto"
          ? "选群 → 点一下，剩下的交给本机完成。"
          : "只导一两条时，复制粘贴最快。"}
      </p>

      {/* ================= 自动通道 ================= */}
      {tab === "auto" && (
        <>
          {statusBusy && (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-500">正在检查本机微信…</div>
          )}

          {!statusBusy && status && !status.available && (
            isLocalHost ? (
              <WeChatSetup status={status} onRefresh={checkStatus} />
            ) : (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <p className="text-xs font-medium text-gray-700">自动扫描需要网页跑在你自己电脑上</p>
                <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
                  你打开的是线上地址，服务器上没有你的微信。用本机{" "}
                  <code className="rounded bg-white px-1">npm run dev</code> 打开{" "}
                  <code className="rounded bg-white px-1">localhost:3000</code>，
                  或在上面切到「手动粘贴」。
                </p>
                <button
                  type="button"
                  onClick={() => setTab("manual")}
                  className="mt-3 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  改用手动粘贴 →
                </button>
              </div>
            )
          )}

          {!statusBusy && status && status.available && !status.connected && (
            <WeChatSetup status={status} onRefresh={checkStatus} />
          )}

          {ready && (
            <>
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>
                  已连上本机微信{status.version ? `（WeFlow ${status.version}）` : ""}
                  {status.accountHint ? ` · 账号 …${status.accountHint}` : ""}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                只有手机上才有的聊天？在手机微信「我 → 设置 → 通用 → 聊天记录迁移与备份 → 迁移到电脑」，
                迁完这边直接能扫到，不用手动复制。
              </p>

              {/* 选群 */}
              <div className="mt-3 rounded-lg border border-gray-200">
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜群名，如 班、通知、学院"
                    className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs outline-none focus:border-indigo-400"
                  />
                  <span className="shrink-0 text-[11px] text-gray-400">
                    已选 {selected.size} / {groups.length}
                  </span>
                </div>

                {groupsBusy ? (
                  <p className="px-3 py-4 text-xs text-gray-400">正在读取群列表…</p>
                ) : (
                  <div className="max-h-56 overflow-y-auto p-1">
                    {filtered.length === 0 && (
                      <p className="px-2 py-3 text-xs text-gray-400">没有匹配的群</p>
                    )}
                    {filtered.map((g) => (
                      <label
                        key={g.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(g.id)}
                          onChange={() => toggleGroup(g.id)}
                          className="h-3.5 w-3.5 shrink-0 accent-indigo-600"
                        />
                        <span className="min-w-0 flex-1 truncate text-gray-700">{g.name}</span>
                        {g.score >= 3 && (
                          <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                            像通知群
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* 范围 + 按钮 */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">范围</span>
                <div className="flex rounded-lg bg-gray-100 p-0.5">
                  {RANGES.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDays(d)}
                      className={`rounded-md px-2.5 py-1 text-xs transition ${
                        days === d ? "bg-white font-medium text-gray-800 shadow-sm" : "text-gray-500"
                      }`}
                    >
                      {d} 天
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void scan()}
                  disabled={!agreed || scanning || selected.size === 0}
                  className="ml-auto rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  {scanning ? "扫描中…" : `扫描 ${selected.size} 个群`}
                </button>
              </div>

              <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                />
                <span>
                  我确认这是我本人的微信，同意读取我勾选的群聊。原始消息只在这台电脑的临时目录里处理，
                  <strong className="text-gray-700">扫描完立即删除</strong>
                  ，提取出的事项也只存在本机。
                </span>
              </label>

              {scanning && (
                <p className="mt-2 text-xs text-gray-500">
                  正在导出并解析…每个群大约 1–3 秒，{selected.size} 个群约{" "}
                  {Math.max(3, selected.size * 2)} 秒。
                </p>
              )}
            </>
          )}
        </>
      )}

      {/* ================= 手动通道 ================= */}
      {tab === "manual" && (
        <>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
            />
            <span>
              我确认这些聊天内容是我自己复制或导出的、我有权处理。解析全程在这台设备完成，
              <strong className="text-gray-700">内容不会上传</strong>
              ，提取出来的事项也只存在本机。
            </span>
          </label>

          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={5}
            placeholder={
              "在这里粘贴（Ctrl+V）。例如：\n张三  2026-11-09 10:23\n明天下午三点在致理楼 319 开会\n\n也可以只粘一句：本周四下午三点在致理楼 319 开会"
            }
            className="mt-3 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-xs leading-relaxed outline-none focus:border-indigo-400"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runPaste}
              disabled={!agreed || busy || !paste.trim()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {busy ? "解析中…" : "解析这段聊天"}
            </button>
            <button
              type="button"
              onClick={() => setPaste("")}
              disabled={busy || !paste}
              className="rounded-lg px-3 py-2 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40"
            >
              清空
            </button>

            <span className="mx-1 h-4 w-px bg-gray-200" />

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!agreed || busy}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              选择已导出的文件
            </button>
            <button
              type="button"
              onClick={() => void pickDir()}
              disabled={!agreed || busy}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-40"
            >
              选择文件夹
            </button>
          </div>

          <input
            ref={dirRef}
            type="file"
            multiple
            onChange={onPickInput}
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <input ref={fileRef} type="file" multiple onChange={onPickInput} className="hidden" />

          <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
            支持 WeFlow 导出的 <code className="rounded bg-gray-100 px-1">.json</code>
            ，以及「昵称 + 时间」格式的 <code className="rounded bg-gray-100 px-1">.txt</code>。
            微信文件夹里的 <code className="rounded bg-gray-100 px-1">.db</code> 是加密的，选它读不出来。
          </p>
        </>
      )}

      {progress && <p className="mt-2 text-xs text-gray-500">{progress}</p>}
      {pasteInfo && <p className="mt-2 text-xs text-gray-400">{pasteInfo}</p>}
      {error && <p className="mt-2 text-xs text-amber-600">{error}</p>}

      {/* ---------- 结果 ---------- */}
      {stats.length > 0 && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
          <p className="font-medium text-gray-700">
            扫了 {scannedTotal?.scanned || 0} 条消息
            {scannedTotal?.hinted ? `，其中 ${scannedTotal.hinted} 条带日期` : ""}
            {added !== null ? ` · 新增 ${added} 条到本机` : ""}
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-gray-400">
            {stats.map((s) => (
              <li key={s.name} className="truncate">
                {s.name}：{s.error ? s.error : `${s.messages} 条 → ${s.items} 条事项`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "manual" && files.length > 0 && (
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
          <p className="font-medium text-gray-700">
            读了 {files.length} 段内容，共 {files.reduce((s, f) => s + f.messages, 0)} 条消息
          </p>
          <p className="mt-1 text-gray-400">
            其中 {items.length} 条能排出时间与事项
            {added !== null ? `，本次新增 ${added} 条到本机` : ""}
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {items.slice(0, 8).map((it, i) => (
            <li key={`${it.startAt}-${i}`} className="flex gap-2 text-xs">
              <span
                className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 ${
                  it.kind === "deadline" ? "bg-rose-50 text-rose-600" : "bg-indigo-50 text-indigo-600"
                }`}
              >
                {it.kind === "deadline" ? "截止" : "会议"}
              </span>
              <span className="shrink-0 text-gray-400">
                {it.startAt.slice(5, 10).replace("-", "/")}
                {it.allDay ? "" : ` ${it.startAt.slice(11, 16)}`}
              </span>
              <span className="truncate text-gray-700">{it.title}</span>
            </li>
          ))}
          {items.length > 8 && (
            <li className="pt-1 text-xs text-gray-400">还有 {items.length - 8} 条，已一并写入本机</li>
          )}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
        规则解析会漏、也会认错日期（比如「下周三」算错一周），导入后请在日历上核对。
      </p>
    </div>
  );
}
