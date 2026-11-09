"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { importDdls } from "@/lib/local-store";

/**
 * 畅课作业同步。
 *
 * 以前畅课这条路只有浏览器扩展：得装扩展、还得专门去畅课页面逛一圈，
 * 页面里没有任何入口能把作业拉进来 —— 用户「看不到畅课 DDL」不是错觉，
 * 是这条链路根本没接完。
 *
 * 现在：在「DDL」页登录一次统一认证，服务端直连畅课的 /api/todos 把作业
 * 拉回来，写进本机 localStorage。密码用完即弃，缓存的只有畅课的 cookie。
 *
 * 只有跑在 localhost 时才能用：登录要在「你自己的机器」上完成，否则密码和
 * 会话会落到部署服务器上，那是别人的机器。
 */

interface Props {
  /** 同步写入本机后，通知外层重新读 localStorage */
  onSynced: () => void | Promise<void>;
}

interface LmsStatus {
  loggedIn: boolean;
  ageDays: number | null;
}

interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

type Phase = "idle" | "login" | "syncing";

export default function LmsSync({ onSynced }: Props) {
  const [status, setStatus] = useState<LmsStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<SyncResult | null>(null);

  const isLocalHost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/lms/status", { cache: "no-store" });
      const j = (await r.json()) as LmsStatus;
      setStatus(j);
      // 没登录不自动弹表单：进页面就摆一个密码框，观感像在索要凭据。
      // 点「登录畅课 →」再展开。
    } catch {
      setStatus({ loggedIn: false, ageDays: null });
    }
  }, []);

  useEffect(() => {
    if (isLocalHost) void refreshStatus();
  }, [isLocalHost, refreshStatus]);

  /** 拉一次作业并写进本机 */
  const sync = useCallback(async () => {
    setBusy(true);
    setPhase("syncing");
    setError("");
    setMsg("");
    setResult(null);
    try {
      const r = await fetch("/api/lms/ddls", { cache: "no-store" });
      const j = await r.json();
      if (r.status === 401) {
        setStatus({ loggedIn: false, ageDays: null });
        setPhase("login");
        setError(j.error || "畅课会话失效，重新登录一次");
        return;
      }
      if (!r.ok) throw new Error(j.error || "读取畅课作业失败");

      const items = Array.isArray(j.items) ? j.items : [];
      if (!items.length) {
        setMsg("畅课里现在没有待办作业（也可能是作业都已截止）");
        setPhase("idle");
        return;
      }
      const r2 = importDdls(items);
      setResult(r2);
      setMsg(`从畅课读到 ${items.length} 条作业`);
      setPhase("idle");
      await onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步失败");
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }, [onSynced]);

  /**
   * 会话还有效时，进页面自动同步一次。
   *
   * 之前必须手点「同步」，用户会以为没拉到（KG 就抱怨过"看不到畅课 DDL"）。
   * 自动跑的条件很窄：localhost + 已登录 + 本次挂载没跑过。
   * 401 时不弹表单（保持"不主动索要密码"的口径），只把状态标成未连接。
   */
  const autoTried = useRef(false);
  useEffect(() => {
    if (!isLocalHost || !status?.loggedIn) return;
    if (autoTried.current) return;
    autoTried.current = true;
    void sync();
  }, [isLocalHost, status?.loggedIn, sync]);

  /** 登录成功后直接同步一次，少点一次按钮 */
  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!form.username.trim() || !form.password) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const r = await fetch("/api/lms/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.username.trim(), password: form.password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "登录失败");
      // 密码不在前端留存，登录完成立刻清掉
      setForm((f) => ({ ...f, password: "" }));
      setStatus({ loggedIn: true, ageDays: 0 });
      setMsg(j.studentId ? `已登录（${j.studentId}），正在拉作业…` : "已登录，正在拉作业…");
      setBusy(false);
      await sync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/lms/login", { method: "DELETE" });
    } catch {
      // 清不掉也只是下次要重新登，不影响别的
    }
    setStatus({ loggedIn: false, ageDays: null });
    setPhase("idle");
    setResult(null);
    setMsg("");
    setError("");
    setBusy(false);
  }

  // 线上环境不显示登录表单：密码不该经过别人的服务器
  if (!isLocalHost) {
    return (
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-medium text-gray-700">畅课作业同步</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          这个功能要登统一认证，只在网页跑在<b>你自己电脑</b>上（localhost）时开放，
          否则密码会经过部署方的服务器。在本地运行 <code className="rounded bg-gray-100 px-1">npm run dev</code>{" "}
          打开即可用；否则用「+ 添加 DDL」手动记。
        </p>
      </div>
    );
  }

  const connected = Boolean(status?.loggedIn);
  const ageText =
    status?.ageDays === null || status?.ageDays === undefined
      ? ""
      : status.ageDays < 1
        ? "今天登录"
        : `${Math.round(status.ageDays)} 天前登录`;

  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet-100 text-[11px] font-bold text-violet-600">
          课
        </span>
        <p className="text-sm font-medium text-gray-800">畅课作业</p>
        {connected ? (
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-600">
            已连接{ageText ? ` · ${ageText}` : ""}
          </span>
        ) : (
          <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">未连接</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {connected ? (
            <>
              <button
                type="button"
                onClick={() => void sync()}
                disabled={busy}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40"
              >
                {phase === "syncing" ? "同步中…" : "一键同步作业"}
              </button>
              <button
                type="button"
                onClick={() => void logout()}
                disabled={busy}
                className="rounded-lg px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40"
              >
                退出
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPhase(phase === "login" ? "idle" : "login")}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
            >
              {phase === "login" ? "收起" : "登录畅课 →"}
            </button>
          )}
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
        登录一次统一认证，把 lms.szu.edu.cn 上的作业截止直接拉进这个列表。
        密码不保存，只缓存畅课的登录态（存在本机 data/ 目录）。
      </p>

      {/* ---------------- 登录表单 ---------------- */}
      {!connected && phase === "login" && (
        <form onSubmit={login} className="mt-3 rounded-lg bg-gray-50 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">
              <span className="mb-1 block text-gray-600">学号</span>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="如 2026xxxxxx"
                autoComplete="username"
                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-violet-400"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-gray-600">统一认证密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="与办事大厅同一个密码"
                autoComplete="current-password"
                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-violet-400"
              />
            </label>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !form.username.trim() || !form.password}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {busy ? "登录中…" : "登录并同步"}
            </button>
            <span className="text-[11px] leading-relaxed text-gray-400">
              走统一身份认证网页登录，密码只用于这一次请求
            </span>
          </div>
        </form>
      )}

      {msg && <p className="mt-2 text-[11px] text-gray-500">{msg}</p>}
      {result && (
        <p className="mt-1 text-[11px] text-gray-500">
          新增 {result.added} 条
          {result.updated > 0 ? ` · 更新 ${result.updated} 条` : ""}
          {result.skipped > 0 ? ` · 跳过 ${result.skipped} 条（已存在）` : ""}
        </p>
      )}
      {error && <p className="mt-2 text-[11px] text-amber-600">{error}</p>}
    </div>
  );
}
