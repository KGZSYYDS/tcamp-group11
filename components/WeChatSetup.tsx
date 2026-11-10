"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 陌生电脑上的接入向导。
 *
 * 目标：用户在一台从没配过的机器上打开这个页面，能自己走完
 * 「装工具 → 让它找到微信 → 拿到密钥」，不需要读文档、不需要命令行。
 *
 * 每一屏只解决一个问题，且都给出「你现在卡在哪」的判断依据：
 *   stage = no-exe   → 没找到工具，先解决「装在哪」
 *   stage = no-key   → 工具在，但打不开微信数据库，先解决「密钥」
 *   stage = ready    → 交给上层显示群列表
 */

export interface WeChatDirInfo {
  dir: string;
  accounts: string[];
  v4: boolean;
  active: boolean;
  from: string;
}

export interface WeFlowStatus {
  available: boolean;
  connected: boolean;
  version: string | null;
  accountHint: string | null;
  error?: string;
  stage: "no-exe" | "no-data" | "no-key" | "ready" | "probing";
  exePath: string | null;
  wechatDirs: WeChatDirInfo[];
  configured: boolean;
}

interface Candidate {
  exe: string;
  from: string;
}

interface Props {
  status: WeFlowStatus | null;
  onRefresh: () => void | Promise<void>;
}

const DOWNLOAD = "https://github.com/334456777/WeFlow/releases";

export default function WeChatSetup({ status, onRefresh }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [dirInput, setDirInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirMsg, setDirMsg] = useState("");
  const [jobMsg, setJobMsg] = useState("");
  const [waitingKey, setWaitingKey] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stage = status?.stage || "no-exe";

  const scan = useCallback(async () => {
    setScanning(true);
    setError("");
    try {
      const r = await fetch("/api/wechat/config", { cache: "no-store" });
      const j = await r.json();
      setCandidates(j.candidates || []);
      if (!(j.candidates || []).length) {
        setError("整台机器上都没扫到 WeFlow，先按第一步装一下");
      }
    } catch {
      setError("扫描失败，检查一下本地服务还在不在");
    } finally {
      setScanning(false);
    }
  }, []);

  /** 用户确认某个 exe，存下来再重新探测 */
  async function usePath(p: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/wechat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exePath: p }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "保存失败");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  /** 用户指定微信聊天记录所在目录：先让 WeFlow 验证，再写进它的配置 */
  async function useDir(d: string) {
    const dir = d.trim().replace(/^"|"$/g, "");
    if (!dir) return;
    setBusy(true);
    setError("");
    setDirMsg("");
    try {
      const r = await fetch("/api/wechat/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wechatDir: dir }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "这个目录不能用");
      setDirMsg(
        j.applied?.accounts
          ? `已把这个目录交给 WeFlow（里面 ${j.applied.accounts} 个账号）`
          : "已设置"
      );
      setDirInput("");
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "这个目录不能用");
    } finally {
      setBusy(false);
    }
  }

  /** 起一个后台任务等微信重登，同时轮询状态 */
  async function waitForKey() {
    setBusy(true);
    setError("");
    setJobMsg("");
    try {
      const r = await fetch("/api/wechat/key", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "启动失败");
      setJobMsg(j.message || "已开始等待");
      setWaitingKey(true);
      let ticks = 0;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        ticks++;
        const s = await fetch("/api/wechat/status", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
        if (s?.connected) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setWaitingKey(false);
          setJobMsg("密钥拿到了，微信库已连上");
          await onRefresh();
        } else if (ticks > 60) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setWaitingKey(false);
          setJobMsg("等了 10 分钟还没好。确认一下微信真的退出重登过，再点一次");
        }
      }, 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "启动失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  // 进到这一步通常说明自动检测没结果，先自动扫一次，省得用户还要点
  useEffect(() => {
    if (stage === "no-exe" && candidates.length === 0 && !scanning) void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // 服务端首次只回 probing，真探测在后台跑（见 /api/wechat/status）。
  // 这时不要渲染「没装工具」的引导，否则会先闪一屏错误结论。
  if (stage === "probing") {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-200 border-t-indigo-500" />
          正在检测本机微信环境（第一次需要几秒）…
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      {/* ---------------- 第一步：没找到工具 ---------------- */}
      {stage === "no-exe" && (
        <>
          <div className="flex items-start gap-2">
            <Step n={1} active />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-gray-800">
                这台电脑还没装「微信导出工具」
              </p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                微信的聊天库是加密的，网页读不了，必须借一个本机工具读一次。装完只需配置一次，
                以后都是一键。
              </p>
              <div className="mt-2 rounded-lg bg-gray-50 p-2.5 text-[11px] leading-relaxed text-gray-600">
                <p className="font-medium text-gray-700">怎么装（3 分钟）</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  <li>
                    打开{" "}
                    <a href={DOWNLOAD} target="_blank" rel="noreferrer" className="text-indigo-600 underline">
                      下载页
                    </a>
                    ，下 `weflow-*-windows-x64.zip`
                  </li>
                  <li>解压到 <b>D:\Tools\WeFlow</b>（别放 C:\Program Files，要有写权限）</li>
                  <li>回到这里点下面的「自动检测」</li>
                </ol>
                <p className="mt-1.5 text-gray-400">
                  它是读你自己电脑上的聊天记录，不上传、不改微信数据。
                </p>
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {scanning ? "正在扫描磁盘…" : "自动检测"}
            </button>
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              已装好，重新检查
            </button>
            <span className="text-[11px] text-gray-400">会在 C/D/E 盘的常见目录里找</span>
          </div>

          {candidates.length > 0 && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5">
              <p className="text-xs font-medium text-emerald-800">找到了 {candidates.length} 个，选一个用：</p>
              <ul className="mt-1.5 space-y-1">
                {candidates.map((c) => (
                  <li key={c.exe}>
                    <button
                      type="button"
                      onClick={() => void usePath(c.exe)}
                      disabled={busy}
                      className="w-full rounded-md bg-white px-2 py-1.5 text-left text-[11px] text-gray-600 hover:bg-emerald-50 disabled:opacity-40"
                    >
                      <span className="block truncate font-mono text-gray-700">{c.exe}</span>
                      <span className="text-gray-400">来源：{c.from}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="mt-3 border-t border-gray-100 pt-2">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
              自动检测没找到？手动填路径
            </summary>
            <div className="mt-2 flex gap-2">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="D:\Tools\WeFlow\weflow.exe"
                className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={() => void usePath(manual)}
                disabled={busy || !manual.trim()}
                className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                用这个
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
              在解压出来的文件夹里找 <code className="rounded bg-gray-100 px-1">weflow.exe</code>，
              右键 →「复制文件地址」粘进来。填 <code className="rounded bg-gray-100 px-1">weflow.cmd</code> 也行。
            </p>
          </details>
        </>
      )}

      {/* ---------------- 第二步：工具在，但没找到聊天记录 ---------------- */}
      {stage === "no-data" && (
        <>
          <div className="flex items-start gap-2">
            <Step n={2} active />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-gray-800">工具找到了，但不知道你的聊天记录在哪</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                微信的存储位置是可以改的，换台电脑 / 换过盘符就猜不到了。下面是我在这台机器上扫到的，
                点一下就能用；一个都没有就手动填。
              </p>
              {status?.exePath && (
                <p className="mt-2 break-all font-mono text-[11px] text-gray-400">
                  工具：{status.exePath}
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* ---------------- 第三步：工具在，密钥不对 ---------------- */}
      {stage === "no-key" && (
        <>
          <div className="flex items-start gap-2">
            <Step n={3} active />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-gray-800">工具找到了，但打不开微信数据库</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                微信每次重新登录都会换一把密钥。让微信退出再登一次，工具就能重新拿到它。
              </p>

              <div className="mt-2 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-800">
                <p className="font-medium">接下来做两件事</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  <li>点下面的按钮，让它开始等</li>
                  <li>
                    去<b>电脑微信</b>：左下角「≡」→ 退出登录 → 重新扫码/输密码登录
                  </li>
                </ol>
                <p className="mt-1.5 text-amber-700">
                  登录完不用管，这边会自动检测到（最多等 10 分钟）。
                </p>
              </div>

              {status?.exePath && (
                <p className="mt-2 truncate font-mono text-[11px] text-gray-400">
                  正在用：{status.exePath}
                </p>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={() => void waitForKey()}
              disabled={busy || waitingKey}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {waitingKey ? "正在等微信重登…" : "开始等待并自动检测"}
            </button>
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              我已重登，立即检查
            </button>
          </div>
          {jobMsg && <p className="mt-2 text-[11px] text-gray-500">{jobMsg}</p>}
          {status?.error && <p className="mt-1 text-[11px] text-gray-400">{status.error}</p>}
        </>
      )}

      {/* ---------------- 微信数据在哪（没就绪时都要显示） ---------------- */}
      {stage !== "ready" && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <p className="text-xs font-medium text-gray-700">
            微信聊天记录在这台电脑的哪个文件夹
          </p>

          {status?.wechatDirs?.length ? (
            <ul className="mt-1.5 space-y-1">
              {status.wechatDirs.map((d) => (
                <li
                  key={d.dir}
                  className={`rounded-lg px-2 py-1.5 ${
                    d.active ? "bg-emerald-50" : "bg-gray-50"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-mono text-[11px] text-gray-600">{d.dir}</p>
                      <p className="mt-0.5 text-[11px] text-gray-400">
                        {d.v4 ? "微信 4.0 格式" : "微信 3.x 格式"} · 账号{" "}
                        {d.accounts.join("、")} · 来自{d.from}
                      </p>
                    </div>
                    {d.active ? (
                      <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
                        正在用
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void useDir(d.dir)}
                        disabled={busy}
                        className="shrink-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                      >
                        用这个
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-600">
              没扫到。自己去确认一下路径：电脑微信左下角「≡」→ 设置 →{" "}
              <b>文件管理</b> →「文件存储位置」，把那里显示的路径复制下来，填到下面。
            </p>
          )}

          <div className="mt-2 flex gap-2">
            <input
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              placeholder="D:\xwechat_files 或 D:\WeChat Files"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-indigo-400"
            />
            <button
              type="button"
              onClick={() => void useDir(dirInput)}
              disabled={busy || !dirInput.trim()}
              className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              用这个目录
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
            填这一层就行（里面能看到 <code className="rounded bg-gray-100 px-1">wxid_</code>{" "}
            开头的文件夹）。填进去会先验证一遍，不对会当场告诉你。
            不用自己打开它 —— 里面是加密的 <code className="rounded bg-gray-100 px-1">.db</code>，
            记事本打开只有乱码。
          </p>
          {dirMsg && <p className="mt-1 text-[11px] text-emerald-600">{dirMsg}</p>}
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-amber-600">{error}</p>}
    </div>
  );
}

function Step({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
        active ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-500"
      }`}
    >
      {n}
    </span>
  );
}
