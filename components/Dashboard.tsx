"use client";

import { useCallback, useEffect, useState } from "react";
import CheckinPanel from "@/components/CheckinPanel";
import CalendarPanel from "@/components/CalendarPanel";
import ProfilePanel from "@/components/ProfilePanel";
import SyncReceiver from "@/components/SyncReceiver";
import PasteImporter from "@/components/PasteImporter";
import DdlPanel from "@/components/DdlPanel";
import ReminderBar from "@/components/ReminderBar";
import { RippleButton } from "./calendar/ui/RippleButton";
import type { SzUser } from "@/lib/szu-types";

type Tab = "calendar" | "ddl" | "checkin" | "paste" | "me";

const TABS: ReadonlyArray<[Tab, string]> = [
  ["calendar", "日历"],
  ["ddl", "作业"],
  ["checkin", "签到"],
  ["paste", "导入"],
  ["me", "我的"],
];

export default function Dashboard() {
  const [user, setUser] = useState<SzUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("calendar");
  const [bannerOff, setBannerOff] = useState(false);
  const [reminderCount, setReminderCount] = useState(0);

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

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-400">加载中…</p>
      </main>
    );
  }

  return (
    <main className="app-shell" data-tab={tab}>
      <header className="app-header">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 shadow-md shadow-indigo-200 sm:h-11 sm:w-11 sm:rounded-2xl">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:hidden">
              <rect x="3" y="4" width="18" height="18" rx="3" />
              <path d="M16 2v4M8 2v4M3 10h18" />
              <path d="M9 16l2 2 4-4" />
            </svg>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hidden sm:block">
              <rect x="3" y="4" width="18" height="18" rx="3" />
              <path d="M16 2v4M8 2v4M3 10h18" />
              <path d="M9 16l2 2 4-4" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight sm:text-2xl">深大日历</h1>
            <p className="mt-0.5 hidden text-sm text-gray-500 sm:block">
              {user
                ? `${user.name ? `${user.name} · ` : ""}${user.studentId}${user.college ? ` · ${user.college}` : ""}`
                : "把在意的事，放进时间里"}
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

      <nav className="app-nav" aria-label="应用导航">
        {TABS.map(([key, label]) => (
          <RippleButton
            key={key}
            onClick={() => setTab(key)}
            aria-current={tab === key ? "page" : undefined}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors sm:px-4 sm:py-1.5 sm:text-sm ${
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
          </RippleButton>
        ))}
      </nav>

      {!user && !bannerOff && tab === "calendar" && (
        <div className="app-banner">
          <p>不用登录也能用 · 登录后自动同步课表</p>
          <div>
            <button onClick={() => setTab("me")}>去登录</button>
            <button onClick={() => setBannerOff(true)} aria-label="关闭提示">×</button>
          </div>
        </div>
      )}

      {tab === "calendar" && <ReminderBar onOpen={() => setTab("ddl")} onCountChange={setReminderCount} />}

      <div className="app-content" key={tab}>
        {tab === "calendar" && <CalendarPanel currentUserId={user?.studentId || ""} />}
        {tab === "ddl" && <DdlPanel />}
        {tab === "checkin" && <CheckinPanel />}
        {tab === "paste" && <PasteImporter />}
        {tab === "me" && (
          <ProfilePanel session={user} onSignedIn={loadSession} onSignOut={loadSession} />
        )}
      </div>

      <footer className="app-footer">
        个人数据仅自己可见 · 公共事件按学院 / 年级匹配 · 数据云端同步
      </footer>
      <SyncReceiver />
    </main>
  );
}
