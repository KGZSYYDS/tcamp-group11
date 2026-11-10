"use client";

import { useState } from "react";
import { importFile } from "@/lib/local-store";

interface Props {
  /** 登录成功、课表已写进本机之后通知外层刷新 */
  onLoggedIn: () => void;
}

/**
 * 统一认证登录卡（内嵌，不是整页门禁）。
 *
 * 登录是可选项：不登录也能看全校日历、截止日期、粘贴导入。
 * 登录只多一件事 —— 自动把课表同步到本机。
 *
 * 为什么不是手机号：手机号证明「你是某个账号的主人」，证明不了「你是在校学生」，
 * 也换不出课表。统一认证才是学校认的凭证。
 *
 * 密码的去向：POST 到本机的 /api/auth/szu，由本机 Node 进程加密后提交给
 * authserver.szu.edu.cn。服务端只用它换一次 ticket，不写文件、不进云库。
 */
export default function LoginPanel({ onLoggedIn }: Props) {
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  /** 服务端回传的诊断轨迹（只有失败时才有，且不含密码与 cookie 值） */
  const [diag, setDiag] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  function diagnosticText() {
    return diag.join("\n");
  }

  async function copyDiag() {
    const text = diagnosticText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板被浏览器拦时，退回「手动全选」——下面本来就是可选中的文本
      setHint("浏览器不允许自动复制，手动选中上面那段文字复制即可");
    }
  }

  async function submit(e: React.FormEvent) {
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

    // 课表要跑好几个接口，给用户一个「还在动」的反馈
    const slow = setTimeout(() => setStep("认证已通过，正在读取课表…"), 3500);

    try {
      const res = await fetch("/api/auth/szu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: studentId.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        setError(data.message || `登录失败（HTTP ${res.status}）`);
        if (data.code === "NEED_CAPTCHA" || data.code === "RATE_LIMITED") {
          setHint("遇到这种情况不要反复点登录 —— 连续失败只会让风控窗口更长。");
        }
        // 服务端把整条链路的走查结果放在 debug.trace 里，原样摊开给人看
        const d = data.debug;
        if (d) {
          const head = [
            `code=${data.code ?? "-"} http=${res.status} node=${d.node ?? "-"} getSetCookie=${d.getSetCookie ?? "-"}`,
            `landed=${d.landed ?? "-"}`,
            `jar=${d.jar ?? "-"}`,
          ];
          setDiag([...head, "--- trace ---", ...(Array.isArray(d.trace) ? d.trace : [])]);
        }
        return;
      }

      // 课表存本机浏览器，登录完立刻能看；服务端不留个人数据
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
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，确认本机服务还在跑");
    } finally {
      clearTimeout(slow);
      setBusy(false);
      setStep("");
    }
  }

  return (
    <div>
      <h2 className="mb-1 font-medium">登录（可选）</h2>
      <p className="mb-4 text-xs leading-relaxed text-gray-400">
        不登录也能用全部功能。登录后会自动把本学期课表同步到这台设备，
        不用再手动导入文件。
      </p>

      <form onSubmit={submit}>
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

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        {hint && <p className="mt-2 text-xs text-amber-600">{hint}</p>}

        {diag.length > 0 && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-gray-500">
                诊断信息（不含密码和 cookie 值）
              </span>
              <button
                type="button"
                onClick={copyDiag}
                className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] text-gray-600 hover:border-indigo-400 hover:text-indigo-600"
              >
                {copied ? "已复制" : "复制诊断信息"}
              </button>
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-gray-600">
              {diagnosticText()}
            </pre>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? step || "登录中…" : "登录并同步课表"}
        </button>
      </form>

      <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
        密码只在本次请求里用于向学校换一次登录票据，不写文件、不进云端数据库。
        服务端只保存学校发的会话 cookie，且<b>按浏览器分开存放</b>，别人拿不到你这份。
        登录后这台设备 7 天免登录；课表存在浏览器的本地存储里。
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
        若提示「需要图形验证码」：先用浏览器打开 authserver.szu.edu.cn 手动登录一次再回来。
      </p>
    </div>
  );
}
