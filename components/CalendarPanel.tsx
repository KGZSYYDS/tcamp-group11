"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  AlignVerticalJustifyStart,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Coffee,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import { scoreAgenda, isRelatedEvent, groupByDate, useAgenda } from "@/lib/useAgenda";
import type { SzUser } from "@/lib/szu-types";
import ClockFace, { EventRow } from "./calendar/ClockFace";
import { MonthView } from "./calendar/MonthWeekView";
import TimelineView from "./calendar/TimelineView";
import EventDialog from "./calendar/EventDialog";
import type { DialogState, EventFormData } from "./calendar/EventDialog";
import { CampusFilterButton, CampusFilterDialog } from "./calendar/CampusFilter";
import { RippleButton } from "./calendar/ui/RippleButton";
import Dock from "./calendar/ui/Dock";
import "./calendar/ui/Dock.css";
import { AnimatedBackground } from "./calendar/ui/AnimatedBackground";
import { SlidingNumber } from "./calendar/ui/SlidingNumber";
import { TextMorph } from "./calendar/ui/TextMorph";
import { useReducedMotion } from "./calendar/ui/useMotionPreference";

type ViewId = "clock" | "month" | "timeline";

const VIEWS: { id: ViewId; label: string; icon: typeof Clock3 }[] = [
  { id: "clock", label: "时钟", icon: Clock3 },
  { id: "month", label: "月历", icon: CalendarDays },
  { id: "timeline", label: "时间轴", icon: AlignVerticalJustifyStart },
];

/**
 * 筛选维度。
 *
 * 以前直接拿 `visual` 当筛选条件，但云端通知的 visual 一律是 notice ——
 * 于是「校园」里混着全校、本学院、别的学院三类东西，「个人」则永远是空的。
 * 画像算了半天（lib/categorize.mjs 的 category）却没人用，等于没生效。
 *
 * 现在按「这条内容对我意味着什么」来分：本学院的进「个人」，明确写了别学院的
 * 单独进「其他院」，剩下才是「校园」。这样勾掉「其他院」就是真的忽略它们。
 */
type Bucket = "course" | "homework" | "campus" | "personal" | "other" | "imported";

const BUCKET_META: Record<Bucket, { name: string; color: string; dark: string; bg: string; hint?: string }> = {
  course: { name: "课程", color: "var(--course)", dark: "var(--course-ink)", bg: "var(--course-bg)" },
  homework: { name: "作业", color: "var(--ddl)", dark: "var(--ddl-ink)", bg: "var(--ddl-bg)" },
  campus: { name: "校园", color: "var(--notice)", dark: "var(--notice-ink)", bg: "var(--notice-bg)", hint: "面向全校的通知" },
  personal: {
    name: "个人",
    color: "var(--personal)",
    dark: "var(--personal-ink)",
    bg: "var(--personal-bg)",
    hint: "标题指向你所在学院的通知，按画像判定",
  },
  other: {
    name: "其他院",
    color: "var(--other)",
    dark: "var(--other-ink)",
    bg: "var(--other-bg)",
    hint: "明确写了别的学院，默认不参与「仅看相关」",
  },
  imported: { name: "导入", color: "var(--imported)", dark: "var(--imported-ink)", bg: "var(--imported-bg)" },
};

const BUCKETS: Bucket[] = ["course", "homework", "campus", "personal", "other", "imported"];

/** 视图事件 → 筛选桶。本地数据按 visual 直判，云端通知按画像算出的 category 拆 */
function bucketOf(event: AgendaEvent): Bucket {
  if (event.visual === "imported") return "imported";
  if (event.visual === "course") return "course";
  if (event.visual === "ddl") return "homework";
  if (event.visual === "personal") return "personal";
  if (event.category === "personal") return "personal";
  if (event.category === "other") return "other";
  return "campus";
}

const HIDDEN_KEY = "szu-cal-hidden";
const CAMPUS_FILTER_KEY = "szu-cal-campus-filter:v1";

function personalEventKey(event: AgendaEvent) {
  return event.preferenceKey || event.id;
}

function addDays(date: Date, n: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function CalendarPanel({ session }: { session: SzUser | null }) {
  const { events, profile, loaded, error, refresh, createAgendaEvent, removeAgendaEvent } =
    useAgenda(session);

  const [view, setView] = useState<ViewId>("month");
  const [quickSwitch, setQuickSwitch] = useState(false);
  const [selected, setSelected] = useState<Date>(startOfToday);
  const [enabled, setEnabled] = useState<Bucket[]>([...BUCKETS]);
  const [onlyRelated, setOnlyRelated] = useState(true);
  const [campusFilterOpen, setCampusFilterOpen] = useState(false);
  const [campusOff, setCampusOff] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const personalStorageKey = `szu-cal-personal:v1:${session?.studentId || "guest"}`;
  const [personal, setPersonal] = useState<{ storageKey: string; ids: string[] }>({ storageKey: "", ids: [] });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  /** Dock 折叠态：默认折叠为灰色带状条，点击/悬停/上滑展开 */
  const [dockOpen, setDockOpen] = useState(false);
  const dockHover = useRef<number>(0);
  /** Dock 自动折叠计时器句柄 */
  const dockHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已挂载过的视图集合，用于懒加载：首次进入才渲染，之后用 display 切换保留 */
  const mountedViews = useRef<Set<ViewId>>(new Set(["month"]));
  const reduced = useReducedMotion();

  // 本地偏好放在挂载后读取，避免服务端渲染时访问 localStorage
  useEffect(() => {
    setHiddenIds(readJson<string[]>(HIDDEN_KEY, []));
    const saved = readJson<unknown>(CAMPUS_FILTER_KEY, []);
    if (Array.isArray(saved)) setCampusOff(saved.filter((key): key is string => typeof key === "string"));
  }, []);

  useEffect(() => {
    const reload = () => {
      const stored = readJson<unknown>(personalStorageKey, []);
      const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
      setPersonal({ storageKey: personalStorageKey, ids });
    };
    function sync(event: StorageEvent) {
      if (event.key === personalStorageKey || event.key === null) reload();
    }
    reload();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [personalStorageKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const displayEvents = useMemo(() => {
    if (personal.storageKey !== personalStorageKey || !personal.ids.length) return events;
    const moved = new Set(personal.ids);
    return events.map((event): AgendaEvent =>
      event.visual === "notice" && moved.has(personalEventKey(event))
        ? { ...event, visual: "personal", movedFromCampus: true }
        : event
    );
  }, [events, personal, personalStorageKey]);

  /** 打分 + 细分栏目过滤后的全集。筛选按钮要显示各类条数，所以单独留一层 */
  const scoredEvents = useMemo(
    () =>
      scoreAgenda(displayEvents, profile, hiddenIds).filter(
        (event) =>
          event.visual !== "notice" ||
          !event.boardGroup ||
          (!campusOff.includes(event.boardGroup) &&
            (!event.boardSubtype || !campusOff.includes(`${event.boardGroup}:${event.boardSubtype}`)))
      ),
    [displayEvents, profile, hiddenIds, campusOff]
  );

  const filteredEvents = useMemo(
    () => scoredEvents.filter((event) => enabled.includes(bucketOf(event))),
    [scoredEvents, enabled]
  );

  /** 每类还剩多少条，直接摆在筛选按钮上——画像有没有生效，看数字就知道 */
  const bucketCounts = useMemo(() => {
    const counts = new Map<Bucket, number>();
    for (const event of scoredEvents) {
      const bucket = bucketOf(event);
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    }
    return counts;
  }, [scoredEvents]);

  const relatedEvents = useMemo(() => filteredEvents.filter(isRelatedEvent), [filteredEvents]);
  const unrelatedCount = filteredEvents.length - relatedEvents.length;
  const visibleEvents = onlyRelated ? relatedEvents : filteredEvents;
  const hasImported = scoredEvents.some((event) => event.visual === "imported");

  const byDay = useMemo(() => groupByDate(visibleEvents), [visibleEvents]);
  const eventsFor = useMemo(
    () => (date: Date) => byDay.get(dateKey(date)) || [],
    [byDay]
  );

  const todayEvents = eventsFor(selected);
  const monday = addDays(selected, -((selected.getDay() + 6) % 7));

  // 全部事件（不受筛选影响）中的今日待办数，用于顶部提示
  const allTodayCount = useMemo(
    () => events.filter((event) => event.date === dateKey(selected)).length,
    [events, selected]
  );

  function switchView(id: ViewId, instant = false) {
    setQuickSwitch(instant);
    mountedViews.current.add(id);
    setView(id);
  }

  function open(next: DialogState) {
    setFormError("");
    setDialog(next);
  }

  function navigate(delta: number) {
    if (view === "month") {
      setSelected(new Date(selected.getFullYear(), selected.getMonth() + delta, 1));
      return;
    }
    setSelected(addDays(selected, delta * 1));
  }

  function toggleFilter(id: Bucket) {
    setEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function saveCampusFilters(next: string[]) {
    setCampusOff(next);
    try { localStorage.setItem(CAMPUS_FILTER_KEY, JSON.stringify(next)); } catch { /* Session still works. */ }
  }

  function togglePersonal(event: AgendaEvent) {
    if (event.visual !== "notice" && !event.movedFromCampus) return;
    const key = personalEventKey(event);
    const current = personal.storageKey === personalStorageKey ? personal.ids : [];
    const restore = event.movedFromCampus;
    const ids = restore ? current.filter((id) => id !== key) : Array.from(new Set([...current, key]));
    try {
      localStorage.setItem(personalStorageKey, JSON.stringify(ids));
    } catch {
      setToast("暂时无法保存分类，请检查浏览器存储");
      return;
    }
    setPersonal({ storageKey: personalStorageKey, ids });
    setToast(restore ? "已恢复到校园" : "已移入个人");
  }

  function hideEvent(event: AgendaEvent) {
    setHiddenIds((prev) => {
      const next = [...prev, event.id];
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
    setToast("已隐藏，可在筛选项右侧恢复");
  }

  function unhideAll() {
    setHiddenIds([]);
    localStorage.setItem(HIDDEN_KEY, "[]");
    setToast("已恢复全部隐藏的日程");
  }

  async function handleSave(data: EventFormData) {
    setSubmitting(true);
    setFormError("");
    try {
      await createAgendaEvent({
        kind: data.kind,
        title: data.title.trim(),
        date: data.date,
        start: data.start,
        end: data.end,
        location: data.location.trim() || undefined,
        note: data.note.trim() || undefined,
        course: data.course.trim() || undefined,
        scope: data.scope,
      });
      setSelected(new Date(`${data.date}T00:00:00`));
      setDialog(null);
      setToast("日程已保存");
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "保存失败");
    }
    setSubmitting(false);
  }

  async function handleDelete(event: AgendaEvent) {
    try {
      await removeAgendaEvent(event);
      setDialog(null);
      setToast("已删除这条日程");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "删除失败");
    }
  }

  function searchEvents(query: string) {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    return visibleEvents.filter((event) =>
      `${event.title} ${event.location} ${event.course || ""}`.toLowerCase().includes(keyword)
    );
  }

  // 键盘 1—3 切视图，/ 打开搜索
  const dialogOpen = Boolean(dialog) || campusFilterOpen;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.matches("input,textarea,select")) return;
      const index = ["1", "2", "3"].indexOf(e.key);
      if (index >= 0) switchView(VIEWS[index].id, true);
      if (e.key === "/") {
        e.preventDefault();
        open({ kind: "search" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen]);

  const dateLabel =
    view === "month"
      ? `${selected.getMonth() + 1} 月`
      : `${selected.getMonth() + 1} 月 ${selected.getDate()} 日`;

  return (
    <div className="calendar-app" data-view={view}>
      <div className="date-controls">
        <div className="date-navigation">
          <button type="button" className="icon-button" aria-label="上一时段" onClick={() => navigate(-1)}>
            <ChevronLeft size={18} />
          </button>
          <h2>{dateLabel}</h2>
          <button type="button" className="icon-button" aria-label="下一时段" onClick={() => navigate(1)}>
            <ChevronRight size={18} />
          </button>
          <button type="button" className="today-button" onClick={() => setSelected(startOfToday())}>
            今天
          </button>
          <button type="button" className="icon-button nav-action" aria-label="搜索日程" onClick={() => open({ kind: "search" })}>
            <Search size={18} />
          </button>
          <RippleButton
            type="button"
            className="icon-button nav-action add-quick"
            aria-label="新建日程"
            onClick={() => open({ kind: "add" })}
          >
            <Plus size={18} />
          </RippleButton>
        </div>

        <div className="filter-group">
          {BUCKETS.filter((id) => id !== "imported" || hasImported).map((id) =>
            id === "campus" ? (
              <CampusFilterButton
                key={id}
                enabled={enabled.includes(id)}
                count={bucketCounts.get(id) || 0}
                onToggle={() => toggleFilter(id)}
                onOpen={() => setCampusFilterOpen(true)}
              />
            ) : (
              <button
                key={id}
                type="button"
                aria-pressed={enabled.includes(id)}
                title={BUCKET_META[id].hint}
                onClick={() => toggleFilter(id)}
              >
                <i style={{ background: BUCKET_META[id].dark }} />
                {BUCKET_META[id].name}
                <span className="bucket-count">{bucketCounts.get(id) || 0}</span>
              </button>
            )
          )}
          <button
            type="button"
            className="filter-toggle"
            aria-pressed={onlyRelated}
            title={onlyRelated ? `已按画像过滤 ${unrelatedCount} 条日程，点击查看全部` : "优先按学院筛选，本科大四可见答辩"}
            onClick={() => setOnlyRelated((v) => !v)}
          >
            <SlidersHorizontal size={15} />
            {onlyRelated ? "仅看相关" : "全部"}
            {onlyRelated && unrelatedCount > 0 ? <span className="related-filter-count">{unrelatedCount}</span> : null}
          </button>
          {hiddenIds.length > 0 ? (
            <button type="button" className="unhide-button" onClick={unhideAll}>
              已隐藏 {hiddenIds.length} 条 · 恢复
            </button>
          ) : null}
        </div>
      </div>

      {view === "clock" ? (
        <div className="week-ribbon">
          {Array.from({ length: 7 }, (_, i) => {
            const date = addDays(monday, i);
            const active = dateKey(date) === dateKey(selected);
            return (
              <button
                key={i}
                type="button"
                className={active ? "selected" : ""}
                onClick={() => setSelected(date)}
                aria-pressed={active}
              >
                <span>周{"一二三四五六日"[i]}</span>
                <strong>{date.getDate()}</strong>
                <i className={eventsFor(date).length ? "has-events" : ""} />
                {active ? (
                  <motion.div
                    className="day-highlight"
                    layoutId="selected-day"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {error ? (
        <div className="cal-error" role="status">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>重试</button>
        </div>
      ) : null}
      {!loaded ? <p className="cal-loading">正在加载云端日程…</p> : null}

      {/* 懒加载：每个视图首次进入才挂载，已挂载的用 display 切换保留状态，切换瞬间完成不重新请求数据/不重放动画 */}
      <div className="view-container" data-view={view}>
        <div className="view-slot" hidden={view !== "clock"}>
          {view === "clock" || mountedViews.current.has("clock") ? (
            <div className="clock-bubble">
              <ClockFace
                instant={quickSwitch}
                events={todayEvents}
                selected={selected}
                onSelect={(event) => open({ kind: "detail", event })}
              />

              <section className="agenda">
                <div className="section-title">
                  <h2>
                    当天安排{" "}
                    <span aria-label={`${todayEvents.length} 项日程`}>
                      <SlidingNumber value={todayEvents.length} />
                    </span>
                  </h2>
                  <button type="button" className="subtle" onClick={() => open({ kind: "add" })}>
                    <Plus size={17} />
                    添加
                  </button>
                </div>

                <div className="agenda-list">
                  {todayEvents.length ? (
                    todayEvents.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        onClick={() => open({ kind: "detail", event })}
                      />
                    ))
                  ) : (
                    <div className="empty">
                      <Coffee />
                      <h3>{loaded ? "这一天的留白，交给你" : "正在读取日程…"}</h3>
                      <p>
                        {loaded
                          ? allTodayCount > 0
                            ? "当前筛选下没有日程，试试打开更多类别。"
                            : "添加一件想做的事，慢慢安排。"
                          : "稍等片刻。"}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            </div>
          ) : null}
        </div>

        <div className="view-slot" hidden={view !== "month"}>
          {view === "month" || mountedViews.current.has("month") ? (
            <MonthView
              selected={selected}
              eventsFor={eventsFor}
              onTogglePersonal={togglePersonal}
              onDate={setSelected}
              onEvent={(event) => open({ kind: "detail", event })}
              onOpenDay={() => switchView("clock")}
            />
          ) : null}
        </div>

        <div className="view-slot" hidden={view !== "timeline"}>
          {view === "timeline" || mountedViews.current.has("timeline") ? (
            <TimelineView
              selected={selected}
              eventsFor={eventsFor}
              onEvent={(event) => open({ kind: "detail", event })}
            />
          ) : null}
        </div>
      </div>

      <footer className="page-footer">
        <span>
          <i />
          {events.length} 条日程 · 数据云端同步
        </span>
        <span>深大日程 / 把在意的事，放进时间里</span>
      </footer>

      <div
        className={`dock-area${dockOpen ? " is-open" : ""}`}
        onMouseEnter={() => {
          if (dockHideTimer.current) { clearTimeout(dockHideTimer.current); dockHideTimer.current = null; }
          setDockOpen(true);
        }}
        onMouseLeave={() => {
          // 离开后延迟自动折叠，给用户一点缓冲
          dockHideTimer.current = setTimeout(() => setDockOpen(false), 1200);
        }}
        onClick={() => {
          if (!dockOpen) setDockOpen(true);
        }}
        role="toolbar"
        aria-label="视图切换"
        aria-expanded={dockOpen}
      >
        <div className="dock-caption">
          换个角度，看时间<span>1 — 3</span>
        </div>
        <Dock
          key={String(reduced)}
          className="view-dock"
          theme="light"
          baseItemSize={66}
          magnification={74}
          distance={100}
          panelHeight={90}
          gap={12}
          tiles={false}
          showLabels={false}
          items={VIEWS.map((item) => {
            const Icon = item.icon;
            return {
              label: item.label,
              active: view === item.id,
              className: view === item.id ? "is-active" : "",
              icon: (
                <>
                  <Icon size={26} aria-hidden="true" />
                  <span className="dock-name">{item.label}</span>
                </>
              ),
              onClick: () => {
                switchView(item.id);
                // 切换后延迟自动折叠
                dockHideTimer.current = setTimeout(() => setDockOpen(false), 900);
              },
            };
          })}
        />
      </div>

      <button
        type="button"
        className="mobile-add"
        aria-label="新建日程"
        onClick={() => open({ kind: "add" })}
      >
        <Plus size={24} />
      </button>

      <EventDialog
        state={dialog}
        onClose={() => setDialog(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        search={searchEvents}
        onSelect={(event) => open({ kind: "detail", event })}
        submitting={submitting}
        error={formError}
      />
      <CampusFilterDialog
        open={campusFilterOpen}
        off={campusOff}
        onToggle={(key) => saveCampusFilters(campusOff.includes(key) ? campusOff.filter((item) => item !== key) : [...campusOff, key])}
        onReset={() => saveCampusFilters([])}
        onClose={() => setCampusFilterOpen(false)}
      />

      <AnimatePresence>
        {toast ? (
          <motion.div
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <Check size={17} />
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export { TextMorph, AnimatedBackground };
