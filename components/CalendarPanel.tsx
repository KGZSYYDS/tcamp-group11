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
import { CATEGORIES } from "@/lib/categorize.mjs";
import { filterByProfile, groupByDate, useAgenda } from "@/lib/useAgenda";
import type { SzUser } from "@/lib/szu-types";
import ClockFace, { EventRow, VISUAL_META } from "./calendar/ClockFace";
import { MonthView } from "./calendar/MonthWeekView";
import TimelineView from "./calendar/TimelineView";
import EventDialog from "./calendar/EventDialog";
import type { DialogState, EventFormData } from "./calendar/EventDialog";
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

/** 四个分类，由 lib/categorize.mjs 判定；「别的学院」不进分类，只在「全部」可见 */
type Category = (typeof CATEGORIES)[number];
type FilterId = Category;

/** 分类 → 配色/文案用的 visual（作业沿用 ddl 的橙、校园沿用 notice 的紫） */
const CATEGORY_VISUAL: Record<Category, "course" | "ddl" | "notice" | "personal"> = {
  course: "course",
  homework: "ddl",
  campus: "notice",
  personal: "personal",
};

const HIDDEN_KEY = "szu-cal-hidden";

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
  const [enabled, setEnabled] = useState<FilterId[]>([...CATEGORIES]);
  const [onlyRelated, setOnlyRelated] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
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
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * 类别开关 + 相关性 + 已隐藏，三层过滤后交给视图。
   *
   * 类别过滤用「多类别归属」：一条事件可同时属于多个类别（如 DDL 既属于「作业」
   * 也属于「课程」），只要它归属的任一类别在 enabled 中就显示。
   * 这样关掉单一类别不会让跨类别事件被误隐藏，避免「只开课程却看到空白」的问题。
   * 未知 visual（未来可能新增的类别）兜底显示，不会被 enabled 静默挡掉。
   */
  const visibleEvents = useMemo(() => {
    const byProfile = filterByProfile(events, profile, onlyRelated, hiddenIds);
    return byProfile.filter((event) => {
      const cat = event.category;
      // 还没分类的 → 兜底显示，绝不静默丢弃
      if (!cat) return true;
      // 别的学院：分类里一律不出现，只有「全部」模式才放出来
      if (cat === "other") return !onlyRelated;
      return enabled.includes(cat);
    });
  }, [events, profile, onlyRelated, hiddenIds, enabled]);

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

  function toggleFilter(id: FilterId) {
    setEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
  const dialogOpen = Boolean(dialog);
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
          {CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={enabled.includes(id)}
              onClick={() => toggleFilter(id)}
            >
              <i style={{ background: VISUAL_META[CATEGORY_VISUAL[id]].dark }} />
              {VISUAL_META[CATEGORY_VISUAL[id]].name}
            </button>
          ))}
          <button
            type="button"
            className="filter-toggle"
            aria-pressed={onlyRelated}
            onClick={() => setOnlyRelated((v) => !v)}
          >
            <SlidersHorizontal size={15} />
            {onlyRelated ? "仅看相关" : "全部"}
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
