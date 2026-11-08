"use client";

import { useState } from "react";
import { cloud } from "@/lib/cloud";

type Pending = {
  account: string;
  verificationId: string;
  isExistingUser: boolean;
};

export default function LoginPanel() {
  const [method, setMethod] = useState<"phone" | "email">("phone");
  const [account, setAccount] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");

  function validate(value: string) {
    if (method === "phone") return /^1\d{10}$/.test(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  async function sendCode() {
    if (!validate(account)) {
      setAccountError(
        method === "phone" ? "请输入正确的 11 位手机号" : "请输入正确的邮箱地址"
      );
      return;
    }
    setAccountError("");
    setError("");
    setSending(true);
    const payload = method === "phone" ? { phone: account } : { email: account };
    const sent = await cloud.auth.sendOtp(payload);
    setSending(false);
    if (sent.error) {
      setError(sent.error.message);
      return;
    }
    setPending({
      account,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser,
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || pending.account !== account) {
      setError("请先获取当前账号的验证码");
      return;
    }
    if (!code.trim()) {
      setError("请输入验证码");
      return;
    }
    setError("");
    setSubmitting(true);
    const base = {
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code.trim(),
    };
    const payload =
      method === "phone" ? { ...base, phone: account } : { ...base, email: account };
    const completed = await cloud.auth.verifyOtp(payload);
    setSubmitting(false);
    if (completed.error) {
      setError(completed.error.message);
      return;
    }
    setPending(null);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-200">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="3" />
            <path d="M16 2v4M8 2v4M3 10h18" />
            <path d="M9 16l2 2 4-4" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-indigo-600">深大日历</h1>
        <p className="mt-2 text-sm text-gray-500">
          作业、签到、考试、体测——与你有关的每一天
        </p>
        <div className="mt-4 flex justify-center gap-4 text-xs text-gray-400">
          <span>公共事件共享</span>
          <span>·</span>
          <span>作业智能同步</span>
          <span>·</span>
          <span>个人相关性过滤</span>
        </div>
      </div>
      <div className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg bg-gray-100 p-1">
          {(["phone", "email"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMethod(m);
                setAccount("");
                setCode("");
                setPending(null);
                setError("");
                setAccountError("");
              }}
              className={`rounded-md py-1.5 text-sm ${
                method === m ? "bg-white font-medium text-indigo-600 shadow-sm" : "text-gray-500"
              }`}
            >
              {m === "phone" ? "手机号登录" : "邮箱登录"}
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">
              {method === "phone" ? "手机号" : "邮箱"}
            </span>
            <input
              value={account}
              onChange={(e) => {
                setAccount(e.target.value.trim());
                setAccountError("");
              }}
              placeholder={method === "phone" ? "11 位手机号" : "如 2026152055@mail.szu.edu.cn"}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
            {accountError && <span className="mt-1 block text-xs text-red-500">{accountError}</span>}
          </label>

          <div className="mt-3 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="验证码"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={sending}
              className="shrink-0 rounded-lg border border-indigo-200 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
            >
              {sending ? "发送中…" : pending ? "重新获取" : "获取验证码"}
            </button>
          </div>
          {pending && (
            <p className="mt-2 text-xs text-emerald-600">
              验证码已发送，请查收{method === "phone" ? "短信" : "邮件"}后输入
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "登录中…" : "登录 / 注册"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-gray-400">
          新用户验证后自动注册，无需设置密码。你的 DDL、签到等个人数据仅自己可见。
        </p>
      </div>
      <div className="mt-4 rounded-2xl bg-indigo-50/60 p-4 text-center">
        <p className="text-xs text-gray-500">
          不装插件也能用：公共事件（体测、活动、答辩）由采集员共享，登录即见。
        </p>
        <a
          href="/szu-calendar-sync.zip"
          download
          className="mt-2 inline-block text-sm font-medium text-indigo-600 hover:underline"
        >
          下载同步助手插件 → 自动同步畅课作业、公文通通知
        </a>
      </div>
    </main>
  );
}
