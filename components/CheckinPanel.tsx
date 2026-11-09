"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Checkin } from "@/lib/types";
import { addCheckin, loadCheckins, loadDdls, removeCheckin } from "@/lib/local-store";

function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export default function CheckinPanel() {
  const [items, setItems] = useState<Checkin[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [form, setForm] = useState({ course: "", teacher: "", occurredAt: nowLocalInput(), note: "" });

  const refresh = useCallback(async () => {
    try {
      const checkinItems = loadCheckins();
      const ddlItems = loadDdls();
      setItems(checkinItems);
      setCourses(
        Array.from(
          new Set<string>([
            ...ddlItems.map((d) => d.course),
            ...checkinItems.map((c) => c.course),
          ])
        )
      );
      setErrorMsg("");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "数据加载失败");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const teachers = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .filter((c) => !form.course || c.course === form.course)
            .map((c) => c.teacher)
            .filter((t): t is string => Boolean(t))
        )
      ),
    [items, form.course]
  );

  const stats = useMemo(() => {
    const map = new Map<string, { course: string; teacher: string; count: number; last: string }>();
    for (const c of items) {
      const key = `${c.course}::${c.teacher || ""}`;
      const entry = map.get(key) || {
        course: c.course,
        teacher: c.teacher || "未填老师",
        count: 0,
        last: c.occurredAt,
      };
      entry.count++;
      if (c.occurredAt > entry.last) entry.last = c.occurredAt;
      map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [items]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.course.trim() || !form.occurredAt) return;
    setSubmitting(true);
    try {
      addCheckin(form);
      setForm({ course: "", teacher: "", occurredAt: nowLocalInput(), note: "" });
      setShowForm(false);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    }
    setSubmitting(false);
  }

  async function remove(id: string) {
    removeCheckin(id);
    setItems((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          老师发起签到后点一下「记录签到」，累计的数据就是以后的选课参考
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          {showForm ? "收起" : "+ 记录签到"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="mb-6 rounded-xl bg-white p-5 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">课程 *</span>
              <input
                list="checkin-course-list"
                required
                value={form.course}
                onChange={(e) => setForm({ ...form, course: e.target.value })}
                placeholder="如：计算机导论"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
              <datalist id="checkin-course-list">
                {courses.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">授课老师（建议填写，用于统计）</span>
              <input
                list="checkin-teacher-list"
                value={form.teacher}
                onChange={(e) => setForm({ ...form, teacher: e.target.value })}
                placeholder="如：赖志辉"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
              <datalist id="checkin-teacher-list">
                {teachers.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">签到时间 *</span>
              <input
                type="datetime-local"
                required
                value={form.occurredAt}
                onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">备注（可选）</span>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="扫码 / 定位 / 纸质 / 手势等"
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

      {errorMsg && <p className="mb-3 text-sm text-red-500">{errorMsg}</p>}
      {!loaded && <p className="py-10 text-center text-sm text-gray-400">加载中…</p>}

      {loaded && items.length === 0 && !showForm && (
        <p className="rounded-xl bg-white py-12 text-center text-sm text-gray-400 shadow-sm">
          还没有签到记录。下次老师发起签到时，点右上角「+ 记录签到」，
          <br />
          攒一学期就能看出哪位老师最爱点名。
        </p>
      )}

      {stats.length > 0 && (
        <section className="mb-6 grid gap-3 sm:grid-cols-2">
          {stats.map((s) => (
            <div key={`${s.course}-${s.teacher}`} className="rounded-xl bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{s.teacher}</span>
                  <span className="ml-2 rounded-md bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">
                    {s.course}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-2xl font-bold text-indigo-600">{s.count}</span>
                  <span className="ml-1 text-xs text-gray-500">次签到</span>
                </div>
              </div>
              <p className="mt-2 text-xs text-gray-400">最近：{formatTime(s.last)}</p>
            </div>
          ))}
        </section>
      )}

      {items.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-gray-500">签到时间线</h3>
          <div className="space-y-2">
            {items.slice(0, 20).map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm shadow-sm"
              >
                <span className="text-gray-500">{formatTime(c.occurredAt)}</span>
                <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">
                  {c.course}
                </span>
                {c.teacher && <span className="font-medium">{c.teacher}</span>}
                {c.note && <span className="text-xs text-gray-400">{c.note}</span>}
                <button
                  onClick={() => remove(c.id)}
                  className="ml-auto text-gray-400 hover:text-red-500"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
