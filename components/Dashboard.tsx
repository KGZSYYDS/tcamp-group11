"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ddl } from "@/lib/types";
import { cloud } from "@/lib/cloud";
import { createDdl, deleteDdl, listDdls, setDdlStatus } from "@/lib/data";
import CheckinPanel from "@/components/CheckinPanel";
import CalendarPanel from "@/components/CalendarPanel";
import LoginPanel from "@/components/LoginPanel";
import ProfilePanel from "@/components/ProfilePanel";
import SyncReceiver from "@/components/SyncReceiver";
import PasteImporter from "@/components/PasteImporter";

type Filter = "all" | "pending" | "done";
type Tab = "calendar" | "ddl" | "checkin" | "paste" | "me";

const HOUR = 3600 * 1000;

function formatDue(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function remainingText(dueAt: string, now: number) {
  const diff = new Date(dueAt).getTime() - now;
  if (diff < 0) return { text: "已截止", level: "overdue" as const };
  const days = Math.floor(diff / (24 * HOUR));
  const hours = Math.floor((diff % (24 * HOUR)) / HOUR);
  const minutes = Math.floor((diff % HOUR) / 60000);
  const text =
    days > 0
      ? `剩 ${days} 天 ${hours} 小时`
      : hours > 0
        ? `剩 ${hours} 小时 ${minutes} 分`
        : `剩 ${minutes} 分钟`;
  const level =
    diff < 24 * HOUR ? ("urgent" as const) : diff < 72 * HOUR ? ("soon" as const) : ("normal" as const);
  return { text, level };
}

const levelStyle = {
  overdue: "bg-gray-100 text-gray-500",
  urgent: "bg-red-50 text-red-600",
  soon: "bg-amber-50 text-amber-600",
  normal: "bg-emerald-50 text-emerald-600",
};

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Dashboard() {
  const [session, setSession] = useState<any>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("calendar");

  const [items, setItems] = useState<Ddl[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState<number>(0);
  const [filter, setFilter] = useState<Filter>("pending");
  const [course, setCourse] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [form, setForm] = useState({ course: "", title: "", dueAt: "", url: "", note: "" });

  useEffect(() => {
    cloud.auth
      .getSession()
      .then(({ data }: any) => {
        setSession(data);
        setChecking(false);
      })
      .catch(() => setChecking(false));
    const ret: any = cloud.auth.onAuthStateChange((_event: string, s: any) => {
      setSession(s);
      setChecking(false);
    });
    return () => {
      if (typeof ret === "function") ret();
      else ret?.unsubscribe?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await listDdls();
      setItems(data);
      setErrorMsg("");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "数据加载失败");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (session) {
      refresh();
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 30000);
      return () => clearInterval(timer);
    }
  }, [session, refresh]);

  const courses = useMemo(
    () => Array.from(new Set(items.map((d) => d.course))),
    [items]
  );

  const stats = useMemo(() => {
    const pending = items.filter((d) => d.status === "pending");
    return {
      pending: pending.length,
      urgent: pending.filter((d) => {
        const diff = new Date(d.dueAt).getTime() - now;
        return diff > 0 && diff < 48 * HOUR;
      }).length,
      done: items.length - pending.length,
    };
  }, [items, now]);

  const visible = items.filter((d) => {
    if (filter !== "all" && d.status !== filter) return false;
    if (course !== "all" && d.course !== course) return false;
    return true;
  });

  async function toggleStatus(ddl: Ddl) {
    const status = ddl.status === "done" ? "pending" : "done";
    setItems((prev) => prev.map((d) => (d.id === ddl.id ? { ...d, status } : d)));
    try {
      await setDdlStatus(ddl.id, status);
    } catch (e) {
      alert(e instanceof Error ? e.message : "操作失败");
      await refresh();
    }
  }

  async function remove(id: string) {
    try {
      await deleteDdl(id);
      setItems((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.course.trim() || !form.title.trim() || !form.dueAt) return;
    setSubmitting(true);
    try {
      await createDdl(form);
      setForm({ course: "", title: "", dueAt: "", url: "", note: "" });
      setShowForm(false);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    }
    setSubmitting(false);
  }

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-400">加载中…</p>
      </main>
    );
  }

  if (!session) return <LoginPanel />;

  return (
    <main className="mx-auto max-w-4xl px-4 py-2 sm:py-6 lg:py-8">
      <header className="mb-2 flex items-center justify-between sm:mb-6">
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
            <p className="mt-0.5 hidden text-sm text-gray-500 sm:block">作业、签到、考试、体测——与你有关的每一天</p>
          </div>
        </div>
        {tab === "ddl" && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {showForm ? "收起" : "+ 添加 DDL"}
          </button>
        )}
      </header>

      <nav className="mb-2 inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-white p-1 shadow-sm ring-1 ring-gray-100 sm:mb-4">
        {([
          ["calendar", "深大日历"],
          ["ddl", "作业 DDL"],
          ["checkin", "签到统计"],
          ["paste", "粘贴导入"],
          ["me", "我的"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors sm:px-4 sm:py-1.5 sm:text-sm ${
              tab === key
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-gray-500 hover:bg-gray-100"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "calendar" && <CalendarPanel currentUserId={session?.user?.id || ""} />}
      {tab === "checkin" && <CheckinPanel />}
      {tab === "paste" && <PasteImporter />}
      {tab === "me" && <ProfilePanel session={session} />}

      {tab === "ddl" && (
        <>
          <section className="mb-6 grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-indigo-600">{stats.pending}</div>
              <div className="mt-1 text-xs text-gray-500">待完成</div>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-red-500">{now ? stats.urgent : "-"}</div>
              <div className="mt-1 text-xs text-gray-500">48 小时内截止</div>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-emerald-500">{stats.done}</div>
              <div className="mt-1 text-xs text-gray-500">已完成</div>
            </div>
          </section>

          {showForm && (
            <form onSubmit={submit} className="mb-6 rounded-xl bg-white p-5 shadow-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">课程 *</span>
                  <input
                    list="course-list"
                    required
                    value={form.course}
                    onChange={(e) => setForm({ ...form, course: e.target.value })}
                    placeholder="如：计算机导论"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                  />
                  <datalist id="course-list">
                    {courses.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">截止时间 *</span>
                  <input
                    type="datetime-local"
                    required
                    value={form.dueAt}
                    onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                  />
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block text-gray-600">作业 / 实验标题 *</span>
                  <input
                    required
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="如：实验4 Python 算法设计"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">提交链接（可选）</span>
                  <input
                    type="url"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://..."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">备注（可选）</span>
                  <input
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="提交方式、注意事项等"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                保存
              </button>
            </form>
          )}

          <section className="mb-4 flex flex-wrap items-center gap-2">
            {(["pending", "all", "done"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-sm ${
                  filter === f
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-100"
                }`}
              >
                {f === "pending" ? "待完成" : f === "done" ? "已完成" : "全部"}
              </button>
            ))}
            <select
              value={course}
              onChange={(e) => setCourse(e.target.value)}
              className="ml-auto rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600"
            >
              <option value="all">全部课程</option>
              {courses.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </section>

          {errorMsg && <p className="mb-3 text-sm text-red-500">{errorMsg}</p>}

          <section className="space-y-3">
            {!loaded && <p className="py-10 text-center text-sm text-gray-400">加载中…</p>}
            {loaded && visible.length === 0 && (
              <p className="py-10 text-center text-sm text-gray-400">
                这里空空如也，点右上角「+ 添加 DDL」开始吧
              </p>
            )}
            {visible.map((ddl) => {
              const r = now ? remainingText(ddl.dueAt, now) : null;
              const done = ddl.status === "done";
              return (
                <article
                  key={ddl.id}
                  className={`rounded-xl bg-white p-4 shadow-sm transition-opacity ${
                    done ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
                      {ddl.course}
                    </span>
                    <h2 className={`font-medium ${done ? "line-through" : ""}`}>{ddl.title}</h2>
                    {r && !done && (
                      <span
                        className={`ml-auto rounded-md px-2 py-0.5 text-xs font-medium ${levelStyle[r.level]}`}
                      >
                        {r.text}
                      </span>
                    )}
                    {done && (
                      <span className="ml-auto rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">
                        已完成
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-sm text-gray-500">
                    截止：{formatDue(ddl.dueAt)}
                    {ddl.note && <span className="ml-3 text-gray-400">{ddl.note}</span>}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-sm">
                    <button
                      onClick={() => toggleStatus(ddl)}
                      className={`rounded-lg px-3 py-1 ${
                        done
                          ? "bg-gray-100 text-gray-500 hover:bg-gray-200"
                          : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
                      }`}
                    >
                      {done ? "恢复待办" : "标记完成"}
                    </button>
                    {ddl.url && (
                      <a
                        href={ddl.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-600 hover:underline"
                      >
                        去提交 →
                      </a>
                    )}
                    <button
                      onClick={() => remove(ddl.id)}
                      className="ml-auto text-gray-400 hover:text-red-500"
                    >
                      删除
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        </>
      )}

      <footer className="mt-10 text-center text-xs text-gray-400">
        个人数据仅自己可见 · 公共事件按学院 / 年级匹配 · 数据云端同步
      </footer>
      <SyncReceiver />
    </main>
  );
}
