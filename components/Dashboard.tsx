"use client";

import { useCallback, useEffect, useState } from "react";
import CheckinPanel from "@/components/CheckinPanel";
import CalendarPanel from "@/components/CalendarPanel";
import ProfilePanel from "@/components/ProfilePanel";
import SyncReceiver from "@/components/SyncReceiver";
import PasteImporter from "@/components/PasteImporter";
import DdlPanel from "@/components/DdlPanel";
import ReminderBar from "@/components/ReminderBar";
import type { SzUser } from "@/lib/szu-types";

type Tab = "calendar" | "ddl" | "checkin" | "paste" | "me";

export default function Dashboard() {
  const [user, setUser] = useState<SzUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("calendar");
  const [bannerOff, setBannerOff] = useState(false);
  /** 提醒条里的条数，用于「截止日期」Tab 的角标 */
  const [reminderCount, setReminderCount] = useState(0);

  /**
   * 登录态只问本机服务端，不再向第三方账号系统查。
   * 注意：查不到不等于拦住用户 —— 没登录照样进主界面，认证只是可选功能。
   */
  const loadSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      const data = await res.json();
      setUser(data?.user || null);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // 只在这个极短的窗口里等，避免已登录用户看到「未登录」闪一下
  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-400">加载中…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600 shadow-md shadow-indigo-200">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="3" />
              <path d="M16 2v4M8 2v4M3 10h18" />
              <path d="M9 16l2 2 4-4" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">深大日历</h1>
            <p className="mt-0.5 text-sm text-gray-500">
              {user
                ? `${user.name ? `${user.name} · ` : ""}${user.studentId}${user.college ? ` · ${user.college}` : ""}`
                : "未登录 · 登录后可自动同步课表"}
            </p>
          </div>
        </div>

        {user ? (
          <button
            onClick={() => setTab("me")}
            className="shrink-0 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-500 shadow-sm ring-1 ring-gray-100 hover:text-indigo-600"
          >
            已登录
          </button>
        ) : (
          <button
            onClick={() => setTab("me")}
            className="shrink-0 rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
          >
            登录
          </button>
        )}
      </header>

      {!user && !bannerOff && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
          <p className="flex-1 text-xs leading-relaxed text-indigo-900/80">
            不用登录也能用：全校日历、截止日期、粘贴导入都在。
            登录只多一件事 —— 自动把本学期课表同步进来。
          </p>
          <button
            onClick={() => setTab("me")}
            className="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-indigo-600 shadow-sm"
          >
            去登录
          </button>
          <button
            onClick={() => setBannerOff(true)}
            aria-label="关闭提示"
            className="shrink-0 px-1 text-base leading-none text-indigo-400 hover:text-indigo-600"
          >
            ×
          </button>
        </div>
      )}

      <ReminderBar onOpen={() => setTab("ddl")} onCountChange={setReminderCount} />

      <nav className="mb-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-white p-1 shadow-sm ring-1 ring-gray-100">
        {([
          ["calendar", "深大日历"],
          ["ddl", "截止日期"],
          ["checkin", "签到统计"],
          ["paste", "粘贴导入"],
          ["me", "我的"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === key
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-gray-500 hover:bg-gray-100"
            }`}
          >
            {label}
            {key === "ddl" && reminderCount > 0 && (
              <span className="ml-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-rose-500 px-1 py-0.5 text-[10px] font-semibold leading-none text-white">
                {reminderCount > 99 ? "99+" : reminderCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* 游客态 currentUserId 传空串：云库里旧 personal 行一律不认作自己的 */}
      {tab === "calendar" && <CalendarPanel currentUserId={user?.studentId || ""} />}
      {tab === "checkin" && <CheckinPanel />}
      {tab === "paste" && <PasteImporter />}
      {tab === "me" && (
        <ProfilePanel session={user} onSignedIn={loadSession} onSignOut={loadSession} />
      )}
      {tab === "ddl" && <DdlPanel />}

      <footer className="mt-10 text-center text-xs text-gray-400">
        课表、作业、签到、群聊待办只存在这台设备的浏览器里 · 公共事件按学院 / 年级匹配
      </footer>
      <SyncReceiver />
    </main>
  );
}
