"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalEvent, Checkin, Ddl, EventKind, Profile } from "@/lib/types";
import {
  createEvent,
  deleteEvent,
  getProfile,
  listEvents,
} from "@/lib/data";
import {
  addMyEvent,
  loadCheckins,
  loadDdls,
  loadMyEvents,
  loadPersonal,
  loadTimetable,
  removeMyEvent,
} from "@/lib/local-store";

type ItemKind = EventKind | "ddl" | "checkin";

interface CalItem {
  id: string;
  kind: ItemKind;
  title: string;
  at: Date;
  /** 时间段事件的结束日期；续日展示时标记 */
  endAt?: Date;
  continued?: boolean;
  link?: string;
  allDay: boolean;
  detail?: string;
  deletable: boolean;
  scope: string;
  /** 是否属于当前用户本人。personal 事件必须为 true 才展示，避免看到别人的个人数据 */
  own: boolean;
  college?: string;
  grade?: string;
}

const KIND_META: Record<ItemKind, { label: string; chip: string; badge: string }> = {
  exam: { label: "考试", chip: "bg-red-500", badge: "bg-red-50 text-red-600" },
  ddl: { label: "DDL", chip: "bg-amber-500", badge: "bg-amber-50 text-amber-600" },
  checkin: { label: "签到", chip: "bg-indigo-500", badge: "bg-indigo-50 text-indigo-600" },
  pe: { label: "体测", chip: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-600" },
  activity: { label: "活动", chip: "bg-violet-500", badge: "bg-violet-50 text-violet-600" },
  meeting: { label: "会议", chip: "bg-cyan-600", badge: "bg-cyan-50 text-cyan-700" },
  deadline: { label: "截止", chip: "bg-orange-500", badge: "bg-orange-50 text-orange-600" },
  other: { label: "其他", chip: "bg-gray-400", badge: "bg-gray-100 text-gray-500" },
};

const SCOPE_LABEL: Record<string, string> = {
  personal: "仅自己",
  school: "全校",
  college: "学院",
  grade: "年级",
  undergraduate: "本科生",
  postgraduate: "硕士生",
  doctoral: "博士生",
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayInput() {
  return dateKey(new Date());
}

/** 公共事件的最近入库时间，形如 11-09 15:33 */
function formatUpdatedAt(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

export default function CalendarPanel({ currentUserId }: { currentUserId: string }) {
  const [items, setItems] = useState<CalItem[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [onlyRelated, setOnlyRelated] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  /** 云库公共事件最后一次入库的时间；全部为空时不展示 */
  const [cloudUpdatedAt, setCloudUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    try {
      setHiddenIds(JSON.parse(localStorage.getItem("szu-cal-hidden") || "[]"));
    } catch {
      setHiddenIds([]);
    }
  }, []);

  function hideItem(id: string) {
    setHiddenIds((prev) => {
      const next = [...prev, id];
      localStorage.setItem("szu-cal-hidden", JSON.stringify(next));
      return next;
    });
  }

  function unhideAll() {
    setHiddenIds([]);
    localStorage.setItem("szu-cal-hidden", "[]");
  }
  const [loaded, setLoaded] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selected, setSelected] = useState(todayInput());
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    kind: "exam" as EventKind,
    title: "",
    date: todayInput(),
    endDate: "",
    link: "",
    allDay: false,
    time: "09:00",
    course: "",
    location: "",
    note: "",
    scope: "personal",
    college: "",
    grade: "",
  });

  const refresh = useCallback(async () => {
    let cloudFailed = false;
    try {
      // 云库只剩公共事件；作业、签到、课表、自建事件全在本机，直接同步读。
      // 云端失败不该让本机那几份也看不见，所以分开处理。
      const events = await listEvents().catch(() => {
        cloudFailed = true;
        return [] as CalEvent[];
      });

      // 新鲜度只看公共事件：created_at 是入库时间，取最新的一条
      const latest = events.reduce((max, e) => {
        const t = e.createdAt ? Date.parse(e.createdAt) : 0;
        return t > max ? t : max;
      }, 0);
      setCloudUpdatedAt(latest ? new Date(latest) : null);
      const ddls = loadDdls();
      const checkins = loadCheckins();
      const p = await getProfile().catch(() => null);
      setProfile(p);

      // 课表来自本机导入，不在 events 表里。它天然属于「当前这个人」——
      // 谁的浏览器里有这个文件，就是谁的课表，不需要任何归属标记或认领。
      const tt = loadTimetable();
      const timetableItems: CalItem[] = (tt?.events || []).map((e, i) => ({
        id: `tt-${tt?.term || "x"}-${i}`,
        kind: "other" as ItemKind,
        title: e.title,
        at: new Date(e.startAt),
        endAt: e.endAt ? new Date(e.endAt) : undefined,
        allDay: Boolean(e.allDay),
        detail: [e.location, e.teacher].filter(Boolean).join(" · "),
        deletable: false,
        scope: "personal",
        own: true,
      }));

      // 群聊里排出来的会议/截止也走本机文件（personal-*.json → localStorage），
      // 不上云的原因和课表一样：谁导入的算谁的。
      const pt = loadPersonal();
      const personalItems: CalItem[] = (pt?.events || []).map((e, i) => ({
        id: `pp-${i}-${e.startAt}`,
        kind: (e.kind === "deadline" ? "deadline" : "meeting") as ItemKind,
        title: e.title,
        at: new Date(e.startAt),
        endAt: e.endAt ? new Date(e.endAt) : undefined,
        allDay: Boolean(e.allDay),
        detail: e.note || e.location || "",
        deletable: false,
        scope: "personal",
        own: true,
      }));

      // 手动新建的「仅自己」事件：同样只在本机（见 local-store.ts 的 MyEvent 注释）
      const myItems: CalItem[] = loadMyEvents().map((e) => ({
        id: `my-${e.id}`,
        kind: (e.kind || "other") as ItemKind,
        title: e.title,
        at: new Date(e.startAt),
        endAt: e.endAt ? new Date(e.endAt) : undefined,
        link: e.link,
        allDay: Boolean(e.allDay),
        detail: [e.course, e.location, e.note].filter(Boolean).join(" · "),
        deletable: true,
        scope: "personal",
        own: true,
      }));

      const merged: CalItem[] = [
        ...events.map((e: CalEvent) => ({
          id: e.id,
          kind: e.kind as ItemKind,
          title: e.title,
          at: new Date(e.startAt),
          endAt: e.endAt ? new Date(e.endAt) : undefined,
          link: e.link,
          allDay: e.allDay,
          detail: [e.course, e.location, e.note].filter(Boolean).join(" · "),
          deletable: e.scope === "personal" || e.ownerId === currentUserId,
          scope: e.scope,
          // 云库里残留的 personal 行（旧版课表）ownerId 是 "anon"，与登录用户对不上，
          // 一律不展示。课表本身已经改走本机文件，这里只是兜住历史数据。
          own: Boolean(currentUserId) && e.ownerId === currentUserId,
          college: e.college,
          grade: e.grade,
        })),
        ...ddls.map((d: Ddl) => ({
          id: d.id,
          kind: "ddl" as ItemKind,
          title: `${d.course} · ${d.title}${d.status === "done" ? "（已完成）" : ""}`,
          at: new Date(d.dueAt),
          allDay: false,
          detail: d.note,
          deletable: false,
          scope: "personal",
          own: true,
        })),
        ...checkins.map((c: Checkin) => ({
          id: c.id,
          kind: "checkin" as ItemKind,
          title: `${c.course}${c.teacher ? ` · ${c.teacher}` : ""} 签到`,
          at: new Date(c.occurredAt),
          allDay: false,
          detail: c.note,
          deletable: false,
          scope: "personal",
          own: true,
        })),
        ...personalItems,
        ...myItems,
        ...timetableItems,
      ];
      setItems(merged);
      setErrorMsg(cloudFailed ? "公共事件加载失败，本机数据不受影响" : "");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "数据加载失败");
    }
    setLoaded(true);
  }, [currentUserId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 相关性过滤：公共事件按画像匹配；个人事件只展示本人的 */
  const visibleItems = useMemo(() => {
    const userLevel = profile?.level || "undergraduate";
    return items.filter((item) => {
      if (hiddenIds.includes(item.id)) return false;
      // 个人数据先校验归属：不是本人的一律不展示（含采集器写入的他人课表）
      if (item.scope === "personal") return item.own;
      if (item.scope === "school") return true;
      if (!onlyRelated) return true;
      if (item.scope === "college") {
        return Boolean(profile?.college && item.college === profile.college);
      }
      if (item.scope === "grade") {
        return Boolean(profile?.grade && item.grade === profile.grade);
      }
      if (item.scope === "undergraduate") return userLevel === "undergraduate";
      if (item.scope === "postgraduate") return userLevel === "postgraduate";
      if (item.scope === "doctoral") return userLevel === "doctoral";
      return true;
    });
  }, [items, onlyRelated, profile, hiddenIds]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalItem[]>();
    for (const item of visibleItems) {
      // 时间段事件展开到范围内每一天（最多 32 天，防异常数据）
      const days: { key: string; continued: boolean }[] = [];
      if (item.endAt && item.endAt.getTime() > item.at.getTime()) {
        const start = new Date(item.at.getFullYear(), item.at.getMonth(), item.at.getDate());
        const end = new Date(item.endAt.getFullYear(), item.endAt.getMonth(), item.endAt.getDate());
        let i = 0;
        for (const d = new Date(start); d <= end && i < 32; d.setDate(d.getDate() + 1), i++) {
          days.push({ key: dateKey(d), continued: i > 0 });
        }
      } else {
        days.push({ key: dateKey(item.at), continued: false });
      }
      for (const day of days) {
        const list = map.get(day.key) || [];
        list.push(day.continued ? { ...item, continued: true } : item);
        map.set(day.key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(a.allDay) - Number(b.allDay) || a.at.getTime() - b.at.getTime());
    }
    return map;
  }, [visibleItems]);

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(start.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return { date: d, key: dateKey(d), inMonth: d.getMonth() === cursor.getMonth() };
    });
  }, [cursor]);

  const today = todayInput();
  const selectedItems = byDay.get(selected) || [];
  const profileIncomplete = onlyRelated && (!profile?.college || !profile?.grade);

  function shiftMonth(delta: number) {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.date) return;
    if (form.scope === "college" && !form.college.trim()) {
      alert("请选择或填写学院名称");
      return;
    }
    if (form.scope === "grade" && !form.grade.trim()) {
      alert("请选择或填写年级");
      return;
    }
    setSubmitting(true);
    const startAt = form.allDay
      ? `${form.date}T00:00:00`
      : `${form.date}T${form.time || "09:00"}:00`;
    try {
      const payload = {
        kind: form.kind,
        title: form.title,
        startAt: new Date(startAt).toISOString(),
        endAt: form.endDate
          ? new Date(`${form.endDate}T23:59:00`).toISOString()
          : undefined,
        link: form.link || undefined,
        allDay: form.allDay,
        course: form.course || undefined,
        location: form.location || undefined,
        note: form.note || undefined,
        scope: form.scope,
        college: form.scope === "college" ? form.college : undefined,
        grade: form.scope === "grade" ? form.grade : undefined,
      };
      // 仅自己 → 本机；全校/学院/年级 → 云库（那本来就是发给大家看的）
      if (form.scope === "personal") {
        addMyEvent({
          kind: payload.kind,
          title: payload.title.trim(),
          startAt: payload.startAt,
          endAt: payload.endAt,
          link: payload.link,
          allDay: payload.allDay,
          course: payload.course,
          location: payload.location,
          note: payload.note,
        });
      } else {
        await createEvent(payload);
      }
      setForm({ ...form, title: "", course: "", location: "", note: "", scope: "personal" });
      setShowForm(false);
      setSelected(form.date);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "保存失败");
    }
    setSubmitting(false);
  }

  async function remove(id: string) {
    try {
      // my- 前缀是本机自建事件，删本地；其余仍走云库（学院/年级等公共事件）
      if (id.startsWith("my-")) {
        removeMyEvent(id.slice(3));
        setItems((prev) => prev.filter((i) => i.id !== id));
        return;
      }
      await deleteEvent(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  }

  /** 本机还没导入任何个人数据时提示一次（课表/待办都不再进云库，所以没有「待认领」这回事） */
  const hasLocalData = useMemo(() => {
    if (typeof window === "undefined") return true;
    return Boolean(loadTimetable() || loadPersonal());
  }, [items]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftMonth(-1)}
            className="rounded-lg bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm hover:bg-gray-50"
          >
            ←
          </button>
          <h2 className="min-w-28 text-center text-lg font-bold">
            {cursor.getFullYear()} 年 {cursor.getMonth() + 1} 月
          </h2>
          <button
            onClick={() => shiftMonth(1)}
            className="rounded-lg bg-white px-3 py-1.5 text-sm text-gray-600 shadow-sm hover:bg-gray-50"
          >
            →
          </button>
          <button
            onClick={() => {
              const d = new Date();
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
              setSelected(todayInput());
            }}
            className="rounded-lg bg-white px-3 py-1.5 text-sm text-indigo-600 shadow-sm hover:bg-gray-50"
          >
            今天
          </button>
        </div>
        <div className="flex items-center gap-3">
          {cloudUpdatedAt && (
            <span
              className="text-xs text-gray-400"
              title="公共事件最近一次入库的时间，本机数据实时更新"
            >
              数据更新于 {formatUpdatedAt(cloudUpdatedAt)}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={onlyRelated}
              onChange={(e) => setOnlyRelated(e.target.checked)}
            />
            只看与我相关
          </label>
          {hiddenIds.length > 0 && (
            <button
              onClick={unhideAll}
              className="text-xs text-amber-600 hover:underline"
            >
              已隐藏 {hiddenIds.length} 条 · 恢复
            </button>
          )}
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            {showForm ? "收起" : "+ 添加事件"}
          </button>
        </div>
      </div>

      {profileIncomplete && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          到「我的」Tab 完善学院和年级后，学院 / 年级公共事件才能精确匹配；未匹配的事件当前被隐藏。
        </p>
      )}

      {!hasLocalData && (
        <p className="mb-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          还没导入个人数据。课表和群聊待办只存在你自己的浏览器里，不上传云端 —— 到「我的」Tab
          导入脚本生成的 timetable-*.json / meetings-*.json 后，上课和开会时间就会出现在这张月历上。
        </p>
      )}

      {showForm && (
        <form onSubmit={submit} className="mb-6 rounded-xl bg-white p-5 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">类型</span>
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as EventKind })}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
              >
                <option value="exam">考试</option>
                <option value="pe">体测</option>
                <option value="activity">活动</option>
                <option value="meeting">会议</option>
                <option value="deadline">截止</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">标题 *</span>
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder={form.kind === "exam" ? "如：线性代数期末考试" : form.kind === "pe" ? "如：1000 米体测" : "事件名称"}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">日期 *</span>
              <input
                type="date"
                required
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <div className="flex items-end gap-3">
              <label className="flex-1 text-sm">
                <span className="mb-1 block text-gray-600">时间</span>
                <input
                  type="time"
                  disabled={form.allDay}
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400 disabled:bg-gray-50 disabled:text-gray-400"
                />
              </label>
              <label className="flex items-center gap-1.5 pb-2.5 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(e) => setForm({ ...form, allDay: e.target.checked })}
                />
                全天
              </label>
            </div>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">可见范围</span>
              <select
                value={form.scope}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scope: e.target.value,
                    college: form.college || profile?.college || "",
                    grade: form.grade || profile?.grade || "",
                  })
                }
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 outline-none focus:border-indigo-400"
              >
                <option value="personal">仅自己</option>
                <option value="school">全校（所有登录用户）</option>
                <option value="college">指定学院</option>
                <option value="grade">指定年级</option>
              </select>
            </label>
            {form.scope === "college" && (
              <label className="text-sm">
                <span className="mb-1 block text-gray-600">学院名称 *</span>
                <input
                  value={form.college}
                  onChange={(e) => setForm({ ...form, college: e.target.value })}
                  placeholder="如：计算机与软件学院"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                />
              </label>
            )}
            {form.scope === "grade" && (
              <label className="text-sm">
                <span className="mb-1 block text-gray-600">年级 *</span>
                <input
                  value={form.grade}
                  onChange={(e) => setForm({ ...form, grade: e.target.value })}
                  placeholder="如：2026 级"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
                />
              </label>
            )}
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">结束日期（时间段事件可选）</span>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">预约 / 详情链接（可选）</span>
              <input
                type="url"
                value={form.link}
                onChange={(e) => setForm({ ...form, link: e.target.value })}
                placeholder="https://..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">关联课程（可选）</span>
              <input
                value={form.course}
                onChange={(e) => setForm({ ...form, course: e.target.value })}
                placeholder="如：线性代数"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-gray-600">地点（可选）</span>
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="如：田径场 / 考场教室"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-indigo-400"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 block text-gray-600">备注（可选）</span>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="需要带什么、注意事项等"
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

      <div className="overflow-hidden rounded-xl bg-white shadow-sm">
        <div className="grid grid-cols-7 border-b border-gray-100 text-center text-xs text-gray-500">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-2">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((cell) => {
            const dayItems = byDay.get(cell.key) || [];
            const isSelected = cell.key === selected;
            return (
              <button
                key={cell.key}
                onClick={() => setSelected(cell.key)}
                className={`min-h-20 border-b border-r border-gray-50 p-1.5 text-left align-top transition-colors sm:min-h-24 ${
                  cell.inMonth ? "" : "bg-gray-50/60"
                } ${isSelected ? "bg-indigo-50/60" : "hover:bg-gray-50"}`}
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    cell.key === today
                      ? "bg-indigo-600 font-bold text-white"
                      : cell.inMonth
                        ? "text-gray-700"
                        : "text-gray-400"
                  }`}
                >
                  {cell.date.getDate()}
                </span>
                <div className="mt-1 space-y-0.5">
                  {dayItems.slice(0, 3).map((item) => (
                    <div key={item.id + (item.continued ? "-c" : "")} className={item.continued ? "opacity-50" : ""}>
                      <span className={`block truncate rounded px-1 py-0.5 text-[11px] leading-tight ${KIND_META[item.kind].badge}`}>
                        {item.title}
                      </span>
                    </div>
                  ))}
                  {dayItems.length > 3 && (
                    <div className="text-[11px] text-gray-400">+{dayItems.length - 3} 更多</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <section className="mt-4 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-medium text-gray-600">
          {selected === today ? "今天" : selected} 的事件（{selectedItems.length}）
        </h3>
        {!loaded && <p className="text-sm text-gray-400">加载中…</p>}
        {loaded && selectedItems.length === 0 && (
          <p className="text-sm text-gray-400">这一天没有事件，点右上角「+ 添加事件」安排上</p>
        )}
        <div className="space-y-2">
          {selectedItems.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded-md px-2 py-0.5 text-xs ${KIND_META[item.kind].badge}`}>
                {KIND_META[item.kind].label}
              </span>
              <span className="text-gray-500">
                {item.allDay
                  ? "全天"
                  : `${String(item.at.getHours()).padStart(2, "0")}:${String(item.at.getMinutes()).padStart(2, "0")}`}
              </span>
              <span className="font-medium">{item.title}</span>
              {item.endAt && (
                <span className="text-xs text-gray-400">
                  至 {item.endAt.getMonth() + 1}月{item.endAt.getDate()}日
                </span>
              )}
              {item.link && (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-indigo-600 hover:underline"
                >
                  去预约 / 详情 →
                </a>
              )}
              {item.scope !== "personal" && (
                <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-600">
                  {item.scope === "college" || item.scope === "grade"
                    ? `${SCOPE_LABEL[item.scope]}·${item.college || item.grade}`
                    : SCOPE_LABEL[item.scope]}
                </span>
              )}
              {item.detail && <span className="text-xs text-gray-400">{item.detail}</span>}
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => hideItem(item.id)}
                  title="不感兴趣，不再显示"
                  className="text-gray-400 hover:text-amber-600"
                >
                  隐藏
                </button>
                {item.deletable && (
                  <button
                    onClick={() => remove(item.id)}
                    className="text-gray-400 hover:text-red-500"
                  >
                    删除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
