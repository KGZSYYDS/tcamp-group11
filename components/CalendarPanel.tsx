"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  AlignVerticalJustifyStart,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Coffee,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type { AgendaEvent, AgendaVisual } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import { filterByProfile, groupByDate, useAgenda } from "@/lib/useAgenda";
import ClockFace, { EventRow, VISUAL_META } from "./calendar/ClockFace";
import { MonthView, WeekView } from "./calendar/MonthWeekView";
import TimelineView from "./calendar/TimelineView";
import EventDialog from "./calendar/EventDialog";
import type { DialogState, EventFormData } from "./calendar/EventDialog";
import Dock from "./calendar/ui/Dock";
import "./calendar/ui/Dock.css";
import { AnimatedBackground } from "./calendar/ui/AnimatedBackground";
import { SlidingNumber } from "./calendar/ui/SlidingNumber";
import { TextMorph } from "./calendar/ui/TextMorph";
import { useReducedMotion } from "./calendar/ui/useMotionPreference";

type ViewId = "clock" | "month" | "week" | "timeline";

const VIEWS: { id: ViewId; label: string; icon: typeof Clock3 }[] = [
  { id: "clock", label: "时钟", icon: Clock3 },
  { id: "month", label: "月历", icon: CalendarDays },
  { id: "week", label: "课表", icon: CalendarRange },
  { id: "timeline", label: "时间轴", icon: AlignVerticalJustifyStart },
];

const FILTERS: AgendaVisual[] = ["course", "ddl", "notice", "personal"];

const HIDDEN_KEY = "szu-cal-hidden";
const INTEREST_KEY = "szu-cal-interests";
const DEFAULT_INTERESTS = ["学术讲座", "竞赛实践", "校园活动"];

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

export default function CalendarPanel({ currentUserId }: { currentUserId: string }) {
  const { events, profile, loaded, error, createAgendaEvent, removeAgendaEvent } =
    useAgenda(currentUserId);

  const [view, setView] = useState<ViewId>("clock");
  const [quickSwitch, setQuickSwitch] = useState(false);
  const [selected, setSelected] = useState<Date>(startOfToday);
  const [enabled, setEnabled] = useState<AgendaVisual[]>([...FILTERS]);
  const [onlyRelated, setOnlyRelated] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [interests, setInterests] = useState<string[]>(DEFAULT_INTERESTS);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const reduced = useReducedMotion();

  // 本地偏好放在挂载后读取，避免服务端渲染时访问 localStorage
  useEffect(() => {
    setHiddenIds(readJson<string[]>(HIDDEN_KEY, []));
    setInterests(readJson<string[]>(INTEREST_KEY, DEFAULT_INTERESTS));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 类别开关 + 相关性 + 已隐藏，三层过滤后交给视图 */
  const visibleEvents = useMemo(() => {
    const byProfile = filterByProfile(events, profile, onlyRelated, hiddenIds);
    return byProfile.filter((event) => enabled.includes(event.visual));
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
    setSelected(addDays(selected, delta * (view === "week" ? 7 : 1)));
  }

  function toggleFilter(id: AgendaVisual) {
    setEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleInterest(tag: string) {
    setInterests((prev) => {
      const next = prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag];
      localStorage.setItem(INTEREST_KEY, JSON.stringify(next));
      return next;
    });
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

  // 键盘 1—4 切视图，/ 打开搜索
  const dialogOpen = Boolean(dialog);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.matches("input,textarea,select")) return;
      const index = ["1", "2", "3", "4"].indexOf(e.key);
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
      : view === "week"
        ? `${monday.getMonth() + 1}.${monday.getDate()} — ${addDays(monday, 6).getMonth() + 1}.${addDays(monday, 6).getDate()}`
        : `${selected.getMonth() + 1} 月 ${selected.getDate()} 日`;

  return (
    <div className="calendar-app">
      <header className="cal-topbar">
        <div className="top-tools">
          <button type="button" className="icon-button" aria-label="搜索日程" onClick={() => open({ kind: "search" })}>
            <Search size={20} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="偏好设置"
            onClick={() => open({ kind: "settings" })}
          >
            <Settings2 size={20} />
          </button>
          <button
            type="button"
            className="icon-button add-quick"
            aria-label="新建日程"
            onClick={() => open({ kind: "add" })}
          >
            <Plus size={20} />
          </button>
        </div>
      </header>

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
        </div>

        <div className="filter-group">
          {FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={enabled.includes(id)}
              onClick={() => toggleFilter(id)}
            >
              <i style={{ background: VISUAL_META[id].dark }} />
              {VISUAL_META[id].name}
            </button>
          ))}
          <button
            type="button"
            className="icon-button"
            aria-label={onlyRelated ? "正在只看与我相关" : "显示全部公共日程"}
            aria-pressed={onlyRelated}
            onClick={() => setOnlyRelated((v) => !v)}
            title={onlyRelated ? "只看与我相关（点击查看全部）" : "显示全部（点击只看与我相关）"}
          >
            <SlidersHorizontal size={17} />
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

      {error ? <p className="cal-error">{error}</p> : null}
      {!loaded ? <p className="cal-loading">正在加载云端日程…</p> : null}

      <motion.div
        key={view}
        className="view-container"
        initial={quickSwitch ? { opacity: 1, transform: "none" } : { opacity: 0, transform: reduced ? "none" : "translateY(6px)" }}
        animate={{ opacity: 1, transform: "none" }}
        transition={{ duration: reduced ? 0 : 0.16, ease: [0.23, 1, 0.32, 1] }}
      >
        {view === "clock" ? (
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

        {view === "month" ? (
          <MonthView
            selected={selected}
            eventsFor={eventsFor}
            onDate={setSelected}
            onEvent={(event) => open({ kind: "detail", event })}
            onOpenDay={() => switchView("clock")}
          />
        ) : null}

        {view === "week" ? (
          <WeekView
            selected={selected}
            eventsFor={eventsFor}
            onEvent={(event) => open({ kind: "detail", event })}
          />
        ) : null}

        {view === "timeline" ? (
          <TimelineView
            key={dateKey(selected) + enabled.join("") + hiddenIds.length}
            selected={selected}
            eventsFor={eventsFor}
            onEvent={(event) => open({ kind: "detail", event })}
          />
        ) : null}
      </motion.div>

      <footer className="page-footer">
        <span>
          <i />
          {events.length} 条日程 · 数据云端同步
        </span>
        <span>深大日程 / 把在意的事，放进时间里</span>
      </footer>

      <div className="dock-area">
        <div className="dock-caption">
          换个角度，看时间<span>1 — 4</span>
        </div>
        <Dock
          key={String(reduced)}
          className="view-dock"
          theme="light"
          baseItemSize={58}
          magnification={72}
          distance={120}
          panelHeight={76}
          gap={18}
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
                  <Icon size={23} />
                  <span className="dock-name">{item.label}</span>
                </>
              ),
              onClick: () => switchView(item.id),
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
        interests={interests}
        onToggleInterest={toggleInterest}
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
