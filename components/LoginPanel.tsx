"use client";

import { useState } from "react";
import { importFile } from "@/lib/local-store";
import { IS_PUBLIC_DEPLOY } from "@/lib/runtime-mode";

interface Props {
  /** 登录成功、课表已写进本机之后通知外层刷新 */
  onLoggedIn: () => void;
}

type Result = {
  ok?: boolean;
  message?: string;
  code?: string;
  profile?: { name?: string; studentId?: string };
  timetable?: unknown;
  warning?: string;
  debug?: { trace?: string[]; [k: string]: unknown };
};

/**
 * 统一认证登录卡（内嵌，不是整页门禁）。
 *
 * 两条路，取决于部署位置：
 *
 * 【公网】用「浏览器授权」
 *   学校的统一认证按**登录地点**风控。服务端在上海机房、人在深圳，密码登录会被
 *   判定为「异地登录」，插一层多因子认证（短信/企业微信），机器永远过不去。
 *   但实测登录票据（CASTGC）不绑 IP —— 所以让用户在自己浏览器里完成登录
 *   （同城，不触发风控），只把票据交过来换会话。密码因此完全不经过服务器。
 *
 * 【本机】直接输学号和密码
 *   同一台机器、同一个网络，不触发异地风控，一步到位。
 */
export default function LoginPanel({ onLoggedIn }: Props) {
  const [mode, setMode] = useState<"browser" | "password">(IS_PUBLIC_DEPLOY ? "browser" : "password");
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [tgt, setTgt] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [diag, setDiag] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  function diagnosticText() {
    return diag.join("\n");
  }

  async function copyDiag() {
    try {
      await navigator.clipboard.writeText(diagnosticText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setHint("浏览器不允许自动复制，手动选中上面那段文字复制即可");
    }
  }

  /** 两条路成功后的收尾完全一样：存课表、清敏感输入、通知外层 */
  function finish(data: Result) {
    if (data.timetable) {
      try {
        importFile(JSON.stringify(data.timetable), "登录时同步");
      } catch (e) {
        setHint(e instanceof Error ? `课表已取到但写入本机失败：${e.message}` : "");
      }
    } else if (data.warning) {
      setHint(`课表这次没取到：${data.warning}。不影响使用，可以稍后再同步一次。`);
    }
    setPassword("");
    setTgt("");
    onLoggedIn();
  }

  function handleFailure(data: Result, status: number) {
    setError(data.message || `登录失败（HTTP ${status}）`);
    if (data.code === "NEED_CAPTCHA" || data.code === "RATE_LIMITED") {
      setHint("遇到这种情况不要反复点登录 —— 连续失败只会让风控窗口更长。");
    }
    if (data.code === "REAUTH") {
      setHint("这不是密码错误。学校把这次登录判定为异地，要求多因子认证，服务端过不去 —— 请改用上面的「浏览器授权」。");
      setMode("browser");
    }
    const d = data.debug;
    if (d) {
      setDiag([
        `code=${data.code ?? "-"} http=${status} node=${d.node ?? "-"} getSetCookie=${d.getSetCookie ?? "-"}`,
        `landed=${d.landed ?? "-"}`,
        `jar=${d.jar ?? "-"}`,
        "--- trace ---",
        ...(Array.isArray(d.trace) ? d.trace : []),
      ]);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setHint("");
    setDiag([]);

    if (!/^\d{6,16}$/.test(studentId.trim())) {
      setError("学号是 6–16 位数字");
      return;
    }
    if (!password) {
      setError("请输入统一认证密码");
      return;
    }

    setBusy(true);
    setStep("正在验证统一认证…");
    const slow = setTimeout(() => setStep("认证已通过，正在读取课表…"), 3500);

    try {
      const res = await fetch("/api/auth/szu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: studentId.trim(), password }),
      });
      const data: Result = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        handleFailure(data, res.status);
        return;
      }
      finish(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，请稍后再试");
    } finally {
      clearTimeout(slow);
      setBusy(false);
      setStep("");
    }
  }

  async function submitTgt(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setHint("");
    setDiag([]);

    if (!/^TGT-/i.test(tgt.trim())) {
      setError("请粘贴以 TGT- 开头的登录票据（CASTGC 的值）");
      return;
    }

    setBusy(true);
    setStep("正在用登录票据建立会话…");

    try {
      const res = await fetch("/api/auth/tgt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tgt: tgt.trim() }),
      });
      const data: Result = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        handleFailure(data, res.status);
        return;
      }
      finish(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，请稍后再试");
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  const tabBase = "rounded-lg px-3 py-1.5 text-xs transition";
  const tabOn = "bg-white text-indigo-700 shadow-sm";
  const tabOff = "text-gray-500 hover:text-gray-700";

  return (
    <div>
      <h2 className="mb-1 font-medium">登录（可选）</h2>
      <p className="mb-3 text-xs leading-relaxed text-gray-400">
        不登录也能用全部功能。登录后会自动把本学期课表同步到这台设备。
      </p>

      <div className="mb-4 inline-flex rounded-lg bg-gray-100 p-1">
        <button type="button" onClick={() => setMode("browser")} className={`${tabBase} ${mode === "browser" ? tabOn : tabOff}`}>
          浏览器授权
        </button>
        <button type="button" onClick={() => setMode("password")} className={`${tabBase} ${mode === "password" ? tabOn : tabOff}`}>
          学号密码
        </button>
      </div>

      {mode === "browser" ? (
        <form onSubmit={submitTgt}>
          <ol className="mb-3 space-y-2 text-xs leading-relaxed text-gray-600">
            <li>
              <span className="mr-1 font-medium text-gray-800">1.</span>
              打开{" "}
              <a
                href="https://authserver.szu.edu.cn/authserver/login"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-600 underline decoration-indigo-300 underline-offset-2"
              >
                统一身份认证
              </a>{" "}
              并登录（在你自己电脑上，这样不会被当成异地）。
            </li>
            <li>
              <span className="mr-1 font-medium text-gray-800">2.</span>
              登录后按 <kbd className="rounded border border-gray-300 bg-gray-50 px-1">F12</kbd> →{" "}
              <b>Application / 应用</b> → <b>Cookies</b> →{" "}
              <code className="text-[11px]">https://authserver.szu.edu.cn</code>，找到{" "}
              <code className="text-[11px]">CASTGC</code>，双击它的 Value 全选复制。
            </li>
            <li>
              <span className="mr-1 font-medium text-gray-800">3.</span>
              粘贴到下面。
            </li>
          </ol>

          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">登录票据（CASTGC）</span>
            <textarea
              value={tgt}
              onChange={(e) => setTgt(e.target.value.trim())}
              rows={2}
              spellCheck={false}
              placeholder="TGT-xxxxxxxx-…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-400"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? step || "登录中…" : "用票据登录"}
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
            票据只用来换一次学校会话，<b>用完即弃、不写文件</b>；服务器保存的是换来的办事大厅会话。
            它和密码一样属于敏感凭据，别发给别人。
          </p>
        </form>
      ) : (
        <form onSubmit={submitPassword}>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">学号</span>
            <input
              value={studentId}
              onChange={(e) => setStudentId(e.target.value.replace(/\s/g, ""))}
              inputMode="numeric"
              autoComplete="username"
              placeholder="如 2024xxxxxx"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>

          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-gray-600">统一认证密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="authserver.szu.edu.cn 的密码"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? step || "登录中…" : "登录并同步课表"}
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
            {IS_PUBLIC_DEPLOY
              ? "服务器不在校园所在地，密码登录常被学校判定为异地并弹出多因子认证 —— 遇到就走「浏览器授权」，那条路不受影响。"
              : "密码只在本次请求里用于向学校换一次登录票据，不写文件、不进云端数据库。"}
          </p>
        </form>
      )}

      {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
      {hint && <p className="mt-2 text-xs text-amber-600">{hint}</p>}

      {diag.length > 0 && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium text-gray-500">诊断信息（不含密码和 cookie 值）</span>
            <button
              type="button"
              onClick={copyDiag}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] text-gray-600 hover:border-indigo-400 hover:text-indigo-600"
            >
              {copied ? "已复制" : "复制诊断信息"}
            </button>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-gray-600">
            {diagnosticText()}
          </pre>
        </div>
      )}
    </div>
  );
}
