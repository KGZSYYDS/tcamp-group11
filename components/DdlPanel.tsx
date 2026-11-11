"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalEvent, Ddl } from "@/lib/types";
import { listEvents } from "@/lib/data";
import { buildDeadlines, sourceLabel, type DeadlineSource, type UnifiedDeadline } from "@/lib/deadlines";
import { hasExplicitClock, stripDeadlinePrefix } from "@/lib/deadline.mjs";
import {
  addDdl,
  loadDdls,
  loadDoneKeys,
  LOCAL_CHANGE_EVENT,
  removeDdl,
  setDdlStatus,
  toggleDoneKey,
} from "@/lib/local-store";
import LmsSync from "./LmsSync";

const HOUR = 3600 * 1000;
type Filter = "all" | "pending" | "done";

/**
 * 截止时刻的展示。
 *
 * 公文通/官网里只写了日期的截止，采集器会补成当天 23:59 以便排序；
 * 那个 23:59 不是原文，`withTime=false` 时只显示日期，避免误导。
 */
function formatDue(iso: string, withTime = true) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
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

const sourceStyle: Record<string, string> = {
  board: "bg-sky-50 text-sky-600",
  web: "bg-teal-50 text-teal-600",
  wechat: "bg-emerald-50 text-emerald-600",
  "lms-sync": "bg-violet-50 text-violet-600",
  manual: "bg-gray-100 text-gray-600",
  "paste-import": "bg-gray-100 text-gray-600",
};

function DdlCard({
  d,
  now,
  onToggle,
  onRemove,
}: {
  d: UnifiedDeadline;
  now: number;
  onToggle: (d: UnifiedDeadline) => void;
  onRemove: (d: UnifiedDeadline) => void;
}) {
  const r = remainingText(d.dueAt, now);
  const done = d.status === "done";
  const hasClock = hasExplicitClock(d.note);
  const noteBody = stripDeadlinePrefix(d.note);
  return (
    <article className={`rounded-xl bg-white p-4 shadow-sm transition-opacity ${done ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${sourceStyle[d.source]}`}>
          {sourceLabel(d.source)}
        </span>
        <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
          {d.tag}
        </span>
        <h2 className={`font-medium ${done ? "line-through" : ""}`}>{d.title}</h2>
        {!done && (
          <span className={`ml-auto rounded-md px-2 py-0.5 text-xs font-medium ${levelStyle[r.level]}`}>
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
        截止：{formatDue(d.dueAt, hasClock)}
        {!hasClock && <span className="ml-1 text-gray-400">（原文只写了日期）</span>}
        {noteBody && <span className="ml-3 text-gray-400">{noteBody.slice(0, 90)}</span>}
      </div>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <button
          onClick={() => onToggle(d)}
          className={`rounded-lg px-3 py-1 ${
            done ? "bg-gray-100 text-gray-500 hover:bg-gray-200" : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
          }`}
        >
          {done ? "恢复待办" : "标记完成"}
        </button>
        {d.url && (
          <a href={d.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
            通知原文 →
          </a>
        )}
        {d.editable && (
          <button onClick={() => onRemove(d)} className="ml-auto text-gray-400 hover:text-red-500">
            删除
          </button>
        )}
      </div>
    </article>
  );
}

export default function DdlPanel() {
  const [ddls, setDdls] = useState<Ddl[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [doneKeys, setDoneKeys] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("pending");
  const [source, setSource] = useState<"all" | DeadlineSource>("all");
  const [tag, setTag] = useState("all");
  const [showExpired, setShowExpired] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [form, setForm] = useState({ course: "", title: "", dueAt: "", url: "", note: "" });

  const refresh = useCallback(async () => {
    // 作业在本机，公共截止在云库：分开取，云端挂了也不该拖累本机那份
    setDdls(loadDdls());
    setDoneKeys(loadDoneKeys());
    try {
      setEvents(await listEvents());
      setErrorMsg("");
    } catch (e) {
      setEvents([]);
      setErrorMsg(
        e instanceof Error
          ? `公共截止加载失败（本机作业不受影响）：${e.message}`
          : "公共截止加载失败，本机作业不受影响"
      );
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => setNow(Date.now()), 30000);
    /**
     * 本机 ddls 变了就重新读一遍。
     *
     * storage 只覆盖「别的标签页」写入，本页自己写收不到 ——
     * 登录时自动同步畅课作业就是本页写入，没有这一条的话
     * DDL 页会一直空着，用户以为同步失败。
     */
    window.addEventListener(LOCAL_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(LOCAL_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  const all = useMemo(() => buildDeadlines(ddls, events, doneKeys), [ddls, events, doneKeys]);

  const tags = useMemo(() => Array.from(new Set(all.map((d) => d.tag))).filter(Boolean), [all]);

  /** 只在数据里真的出现过的来源，避免列一排空选项 */
  const sources = useMemo(() => {
    const present = new Set(all.map((d) => d.source));
    const order: DeadlineSource[] = ["board", "web", "wechat", "lms-sync", "manual", "paste-import"];
    return order.filter((s) => present.has(s));
  }, [all]);

  /** 已截止但没勾掉的单独放下面，不然一进页面先看到一堆过期的。 */
  const { upcoming, expired, doneList, stats } = useMemo(() => {
    const pendingAll = all.filter((d) => d.status === "pending");
    const up = pendingAll.filter((d) => new Date(d.dueAt).getTime() >= now);
    const ex = pendingAll
      .filter((d) => new Date(d.dueAt).getTime() < now)
      .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
    return {
      upcoming: up,
      expired: ex,
      doneList: all.filter((d) => d.status === "done"),
      stats: {
        pending: up.length,
        urgent: up.filter((d) => new Date(d.dueAt).getTime() - now < 48 * HOUR).length,
        expired: ex.length,
        done: all.length - pendingAll.length,
      },
    };
  }, [all, now]);

  const bySource = (list: UnifiedDeadline[]) =>
    source === "all" ? list : list.filter((d) => d.source === source);

  const byTag = (list: UnifiedDeadline[]) =>
    tag === "all" ? list : list.filter((d) => d.tag === tag);

  const visible = byTag(bySource(filter === "pending" ? upcoming : filter === "done" ? doneList : all));
  /**
   * 「已截止」单独分组只在「待交」视图下有意义：
   * filter==="all" 时 visible 取的就是 all，已经包含这些条目，再收一遍会重复渲染。
   */
  const expiredVisible = filter === "pending" ? byTag(bySource(expired)) : [];

  async function toggle(item: UnifiedDeadline) {
    if (item.editable) {
      const id = item.key.replace(/^ddl:/, "");
      const status = item.status === "done" ? "pending" : "done";
      const ok = setDdlStatus(id, status);
      if (ok) {
        setDdls(loadDdls());
      } else {
        alert("这条作业已经不在本机了，可能被别的标签页删掉，刷新看看");
        await refresh();
      }
      return;
    }
    // 公共 / 群聊截止：只在本机记一笔「我交过了」，不上云
    setDoneKeys(toggleDoneKey(item.key));
  }

  async function remove(item: UnifiedDeadline) {
    if (!item.editable) return;
    const id = item.key.replace(/^ddl:/, "");
    removeDdl(id);
    setDdls(loadDdls());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.course.trim() || !form.title.trim() || !form.dueAt) return;
    setSubmitting(true);
    try {
      addDdl(form);
      setForm({ course: "", title: "", dueAt: "", url: "", note: "" });
      setShowForm(false);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    }
    setSubmitting(false);
  }

  return (
    <>
      <section className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          公文通的报名 / 提交截止、班级群里的通知、畅课作业，都汇总在这里。
          <br />
          你手动加的作业和「已完成」状态只存这台设备，不上传云端。
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          {showForm ? "收起" : "+ 添加 DDL"}
        </button>
      </section>

      <LmsSync onSynced={refresh} />

      <section className="mb-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-2xl font-bold text-indigo-600">{stats.pending}</div>
          <div className="mt-1 text-xs text-gray-500">
            待完成
            {stats.expired > 0 && <span className="text-gray-400">（另 {stats.expired} 条已截止）</span>}
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-2xl font-bold text-red-500">{stats.urgent}</div>
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
              <span className="mb-1 block text-gray-600">课程 / 来源 *</span>
              <input
                list="ddl-tag-list"
                required
                value={form.course}
                onChange={(e) => setForm({ ...form, course: e.target.value })}
                placeholder="如：计算机导论"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
              <datalist id="ddl-tag-list">
                {tags.map((t) => (
                  <option key={t} value={t} />
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
              <span className="mb-1 block text-gray-600">要交什么 *</span>
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
              filter === f ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            {f === "pending" ? "待完成" : f === "done" ? "已完成" : "全部"}
          </button>
        ))}
        <select
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="ml-auto rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600"
        >
          <option value="all">全部标签</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </section>

      {sources.length > 1 && (
        <section className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400">来源</span>
          {(["all", ...sources] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`rounded-full px-2.5 py-1 text-xs ${
                source === s ? "bg-gray-800 text-white" : "bg-white text-gray-600 hover:bg-gray-100"
              }`}
            >
              {s === "all" ? "全部" : sourceLabel(s)}
            </button>
          ))}
        </section>
      )}

      {errorMsg && <p className="mb-3 text-sm text-red-500">{errorMsg}</p>}

      <section className="space-y-3">
        {!loaded && <p className="py-10 text-center text-sm text-gray-400">加载中…</p>}
        {loaded && visible.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400">
            {filter === "done"
              ? "还没有勾掉任何一条。"
              : "没有待交的东西。可以去「深大日历」看看，或点「+ 添加 DDL」手动记一条。"}
          </p>
        )}
        {visible.map((d) => (
          <DdlCard key={d.key} d={d} now={now} onToggle={toggle} onRemove={remove} />
        ))}
      </section>

      {expiredVisible.length > 0 && (
        <section className="mt-8">
          <button
            onClick={() => setShowExpired((v) => !v)}
            className="flex w-full items-center gap-2 text-sm text-gray-400 hover:text-gray-600"
          >
            <span>{showExpired ? "▾" : "▸"}</span>
            已截止未完成（{expiredVisible.length}）
          </button>
          {showExpired && (
            <div className="mt-3 space-y-3 opacity-70">
              {expiredVisible.map((d) => (
                <DdlCard key={d.key} d={d} now={now} onToggle={toggle} onRemove={remove} />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
