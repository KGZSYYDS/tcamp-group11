"use client";

import { useState } from "react";
import { importDdls, importFile } from "@/lib/local-store";

interface Props {
  /** 登录成功、课表已写进本机之后通知外层刷新 */
  onLoggedIn: () => void;
}

type Result = {
  ok?: boolean;
  needMfa?: boolean;
  mfaToken?: string;
  phone?: string;
  channel?: string;
  message?: string;
  code?: string;
  profile?: { name?: string; studentId?: string };
  timetable?: unknown;
  /** 服务端顺手把畅课也连上了（用同一枚 CAS 票据换的票） */
  lmsOk?: boolean;
  warning?: string;
  debug?: { trace?: string[]; [k: string]: unknown };
};

/**
 * 统一认证登录卡（内嵌，不是整页门禁）。
 *
 * 两步：
 *   1. 学号 + 密码
 *   2. 如果学校要求二次认证，输一次手机验证码
 *
 * 为什么会有第 2 步：服务端每次登录都是全新会话，在学校的统一认证看来就是
 * 「非可信浏览器」，所以要一条短信码。这跟用户在不在校园网无关 ——
 * 触发条件是「这台设备没被信任过」。
 *
 * 这一步完全在服务端完成（发码 → 收码 → 提交），用户只需要看一眼手机、
 * 把 6 位数字填进来。不需要开发者工具，也不需要复制任何东西。
 */
export default function LoginPanel({ onLoggedIn }: Props) {
  const [stage, setStage] = useState<"password" | "code">("password");
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState("短信验证码");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [diag, setDiag] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const diagnosticText = () => diag.join("\n");

  async function copyDiag() {
    try {
      await navigator.clipboard.writeText(diagnosticText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setHint("浏览器不允许自动复制，手动选中上面那段文字复制即可");
    }
  }

  /** 成功后收尾：存课表、清敏感输入、通知外层 */
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
    setCode("");
    setMfaToken("");

    /**
     * 畅课已经连上了，就把作业一起拉进本机。
     *
     * 不做这一步的话，用户登录完切到「DDL」页仍然是空的 ——
     * 得等他自己找到那张卡片点同步，而他根本不知道有这回事。
     * 拉失败不提示：课表已经好了，作业可以稍后再同步。
     */
    if (data.lmsOk) {
      void (async () => {
        try {
          const r = await fetch("/api/lms/ddls", { cache: "no-store" });
          if (!r.ok) return;
          const j = await r.json();
          const items = Array.isArray(j.items) ? j.items : [];
          if (items.length) importDdls(items);
        } catch {
          /* 忽略：DDL 页那张卡片还能手动同步 */
        }
      })();
    }

    onLoggedIn();
  }

  function collectDiag(data: Result, status: number) {
    const d = data.debug;
    if (!d) return;
    setDiag([
      `code=${data.code ?? "-"} http=${status} node=${d.node ?? "-"} getSetCookie=${d.getSetCookie ?? "-"}`,
      `landed=${d.landed ?? "-"}`,
      ...(Array.isArray(d.trace) ? ["--- trace ---", ...d.trace] : []),
    ]);
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
    setStep("正在登录…");
    const slow = setTimeout(() => setStep("登录中，正在读取课表…"), 4000);

    try {
      const res = await fetch("/api/auth/szu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: studentId.trim(), password }),
      });
      const data: Result = await res.json().catch(() => ({}));
      setPassword("");
      if (data.needMfa && data.mfaToken) {
        setMfaToken(data.mfaToken);
        setPhone(data.phone ?? "");
        setChannel(data.channel ?? "短信验证码");
        setStage("code");
        setHint(data.message ?? "");
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.message || `登录失败（HTTP ${res.status}）`);
        collectDiag(data, res.status);
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

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const clean = code.replace(/\D/g, "");
    if (clean.length < 4) {
      setError("请输入手机上收到的验证码");
      return;
    }

    setBusy(true);
    setStep("正在验证…");

    try {
      const res = await fetch("/api/auth/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaToken, code: clean }),
      });
      const data: Result = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.message || `验证失败（HTTP ${res.status}）`);
        if (data.code === "MFA_EXPIRED") {
          setStage("password");
          setMfaToken("");
        } else {
          setCode("");
        }
        collectDiag(data, res.status);
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

  return (
    <div>
      <h2 className="mb-1 font-medium">登录（可选）</h2>
      <p className="mb-3 text-xs leading-relaxed text-gray-400">
        不登录也能用全部功能。登录后会自动把本学期课表同步到这台设备。
      </p>

      {stage === "password" ? (
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
            密码只在本次请求里用于向学校登录，不写文件、不进数据库。
            如果学校要求二次认证，下一步会让你填一次手机上收到的验证码。
          </p>
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2.5 text-xs leading-relaxed text-indigo-900">
            学校要求二次认证（{channel}），验证码已发到{" "}
            <b>{phone || "你绑定的手机"}</b>。看一眼手机，把数字填进来就行。
          </div>

          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-gray-600">验证码</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="6 位数字"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-lg tracking-[0.35em] outline-none focus:border-indigo-400"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? step || "验证中…" : "验证并同步课表"}
          </button>

          <button
            type="button"
            onClick={() => {
              setStage("password");
              setMfaToken("");
              setCode("");
              setHint("");
              setError("");
            }}
            className="mt-2 w-full rounded-lg border border-gray-200 py-2 text-xs text-gray-500 hover:border-gray-300 hover:text-gray-700"
          >
            没收到 / 重来一次
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
            验证码 5 分钟内有效。这是学校对「没被信任过的设备」的固定要求，
            和你在哪个网络无关。
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
