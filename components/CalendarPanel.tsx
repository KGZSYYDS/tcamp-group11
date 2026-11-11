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
  X,
} from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import { scoreAgenda, isRelatedEvent, groupByDate, isFreshman, useAgenda } from "@/lib/useAgenda";
import type { SzUser } from "@/lib/szu-types";
import ClockFace, { EventRow } from "./calendar/ClockFace";
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

/**
 * 筛选维度。
 *
 * 两条正交的轴，不要混在一起：
 *
 * ① **内容类型**（这条值不值得占用注意力）
 *    公文通一天能进 50 条，绝大多数是答辩公告、名单公示、会议新闻、学术讲座。
 *    它们确实「发给全校」，但对学生没有可执行的动作 —— 这些默认不显示。
 *    只有「能办事」的默认显示：教务（选课/停课/考试，错过要出事）、
 *    领航讲座学分、奖助申请、实习竞赛招募。
 *
 *    例外是「有人需要有人不需要」的那几类（讲座、公示、事务）：
 *    它们不属于噪音，只是不该默认占位 —— 单独成类、默认关闭，
 *    用户要的时候一键打开，而不是每次刷新都重新关一遍。
 *
 * ② **受众匹配**（这条是不是给我的）
 *    由「仅看相关」承担，看画像里的学院与培养层次，见 lib/relevance.mjs。
 *    以前把这一条当成唯一标准，所以 45 条噪音全都「相关」。
 *
 * 默认原则：宁可少显示。用户需要时会自己把某一类打开，
 * 而不是让用户每天先筛掉 40 条才看见作业。
 */
type Bucket =
  | "course"
  | "homework"
  | "academic"
  | "personal"
  | "linghang"
  | "aid"
  | "opportunity"
  | "lecture"
  | "publicity"
  | "admin"
  | "misc"
  | "imported";

const BUCKET_META: Record<Bucket, { name: string; color: string; dark: string; bg: string }> = {
  course: { name: "课程", color: "var(--course)", dark: "var(--course-ink)", bg: "var(--course-bg)" },
  homework: { name: "作业", color: "var(--ddl)", dark: "var(--ddl-ink)", bg: "var(--ddl-bg)" },
  academic: {
    name: "教务",
    color: "var(--notice)",
    dark: "#6b4a9e",
    bg: "#f1ebfa",
  },
  personal: {
    name: "我的",
    color: "var(--personal)",
    dark: "var(--personal-ink)",
    bg: "var(--personal-bg)",
  },
  linghang: {
    name: "领航讲座",
    color: "var(--notice)",
    dark: "#2f7d5d",
    bg: "#e9f6ef",
  },
  aid: {
    name: "奖助",
    color: "var(--notice)",
    dark: "#a2601f",
    bg: "#fdf3e3",
  },
  opportunity: {
    name: "机会",
    color: "var(--notice)",
    dark: "#2f5f9e",
    bg: "#eaf1fb",
  },
  lecture: {
    name: "讲座",
    color: "var(--notice)",
    dark: "var(--notice-ink)",
    bg: "var(--notice-bg)",
  },
  publicity: {
    name: "公示",
    color: "var(--notice)",
    dark: "var(--other-ink)",
    bg: "var(--other-bg)",
  },
  admin: {
    name: "事务",
    color: "var(--notice)",
    dark: "#5c6478",
    bg: "#eef0f4",
  },
  misc: {
    name: "其他",
    color: "var(--notice)",
    dark: "#6b7280",
    bg: "#f1f2f5",
  },
  imported: { name: "导入", color: "var(--imported)", dark: "var(--imported-ink)", bg: "var(--imported-bg)" },
};

/**
 * 按钮顺序 = 重要程度。默认开着的排前面。
 * 后面四类（讲座/公示/事务/其他）是「需要时才打开」的抽屉。
 */
const BUCKETS: Bucket[] = [
  "course",
  "homework",
  "academic",
  "personal",
  "linghang",
  "aid",
  "opportunity",
  "lecture",
  "publicity",
  "admin",
  "misc",
  "imported",
];

/** 不管画像是谁都默认打开：课程、作业、教务、自己的日程 */
const ALWAYS_ON: Bucket[] = ["course", "homework", "academic", "personal", "imported"];

/**
 * 按画像算默认打开哪些。
 *
 * 领航讲座是本科新生的学分要求，大二之后大部分人已经刷够，
 * 所以只有大一默认打开，其他人需要自己开。
 */
function defaultBuckets(freshman: boolean): Bucket[] {
  const on: Bucket[] = [...ALWAYS_ON];
  if (freshman) on.push("linghang");
  on.push("aid", "opportunity");
  return on;
}

/** 视图事件 → 筛选桶：先看是不是本机数据，再看通知的内容类型 */
function bucketOf(event: AgendaEvent): Bucket {
  if (event.visual === "imported") return "imported";
  if (event.visual === "course") return "course";
  if (event.visual === "ddl") return "homework";
  if (event.visual === "personal") return "personal";

  // 公共通知按内容类型分。没判出来的一律进 misc（默认关），
  // 不能默认塞进「课程」这种高优先级桶里蹭曝光。
  const kind = event.noticeKind;
  if (kind === "linghang" || kind === "aid" || kind === "opportunity" || kind === "academic" ||
      kind === "lecture" || kind === "publicity" || kind === "admin") {
    return kind;
  }
  return "misc";
}

const HIDDEN_KEY = "szu-cal-hidden";
/**
 * 分类偏好的存储版本。
 *
 * 每次改动「有哪些分类」都要升版本：老版本存的是旧分类集合，
 * 里面没有新加的类（比如教务），沿用会让老用户永远看不到它。
 * 升版本 = 丢掉旧偏好、按新规则重算一次默认值，代价只是用户重新挑一次。
 */
const BUCKETS_KEY = "szu-cal-buckets:v3";

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
  /**
   * 先按「什么都没打开」渲染，等画像到了再套默认值。
   *
   * 为什么不直接 useState(defaultBuckets(false))：profile 是异步来的，
   * 用初值会先闪一版「领航讲座关着」，大一用户看到的就是错的。
   * 而空数组只是一瞬间的加载态，不会误导。
   */
  const [enabled, setEnabled] = useState<Bucket[]>([]);
  const [onlyRelated, setOnlyRelated] = useState(true);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterDialog = useRef<HTMLDialogElement>(null);
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

  /**
   * 画像是谁，只需要一个布尔值来决定「领航讲座」开不开。
   *
   * 单独提出来做依赖：直接依赖 profile 对象会随课表/通知刷新而变身份，
   * 导致下面的 effect 反复 setState。
   */
  const freshman = isFreshman(profile);

  /**
   * 画像到位后算默认值。
   *
   * 判断依据是「本地有没有存过用户自己挑的分类」：
   * - 存过 → 一律以存下来的为准，绝不覆盖用户的选择；
   * - 没存过 → 按当前画像重算，所以云端画像比首帧晚到也能纠正过来
   *   （否则大一用户的「领航讲座」会一直是关的）。
   */
  useEffect(() => {
    const saved = readJson<unknown>(BUCKETS_KEY, null);
    if (Array.isArray(saved)) {
      const known = saved.filter((id): id is Bucket => (BUCKETS as string[]).includes(id as string));
      if (known.length) {
        setEnabled(known);
        return;
      }
    }
    setEnabled(defaultBuckets(freshman));
  }, [freshman, session?.studentId]);

  const displayEvents = useMemo(() => {
    if (personal.storageKey !== personalStorageKey || !personal.ids.length) return events;
    const moved = new Set(personal.ids);
    return events.map((event): AgendaEvent =>
      event.visual === "notice" && moved.has(personalEventKey(event))
        ? { ...event, visual: "personal", movedFromCampus: true }
        : event
    );
  }, [events, personal, personalStorageKey]);

  /**
   * 打分后的全集。分类按钮要显示各类条数，所以单独留一层。
   *
   * 这里不做任何「隐藏」判断 —— 隐藏只发生在 filteredEvents。
   * 否则按钮上的数字会变成 0，用户就不知道被藏了多少条。
   */
  const scoredEvents = useMemo(
    () => scoreAgenda(displayEvents, profile, hiddenIds),
    [displayEvents, profile, hiddenIds]
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

  /**
   * 勾选/取消某一类。
   *
   * 顺手做成「至少留一个」：全关掉会看到空白页，用户以为坏了。
   */
  function toggleBucket(id: Bucket) {
    setEnabled((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (!next.length) return prev;
      try {
        localStorage.setItem(BUCKETS_KEY, JSON.stringify(next));
      } catch {
        /* 存不了就只影响这次，不打断操作 */
      }
      return next;
    });
  }

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
  const dialogOpen = Boolean(dialog) || filterOpen;
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
      ? `${selected.getMonth() + 1}月`
      : `${selected.getMonth() + 1}月${selected.getDate()}日`;

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
          <button
            type="button"
            className="calendar-filter-trigger"
            aria-label="筛选"
            aria-haspopup="dialog"
            aria-expanded={filterOpen}
            aria-controls="calendar-filter-panel"
            onClick={() => {
              filterDialog.current?.showModal();
              setFilterOpen(true);
            }}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            <span>筛选</span>
          </button>
        </div>
      </div>

      <dialog
        ref={filterDialog}
        id="calendar-filter-panel"
        className="dialog calendar-filter-dialog"
        aria-labelledby="calendar-filter-heading"
        onClose={() => setFilterOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="calendar-filter-body">
          <header>
            <h2 id="calendar-filter-heading">筛选</h2>
            <button type="button" className="icon-button" aria-label="关闭筛选" onClick={() => filterDialog.current?.close()}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div className="calendar-filter-grid">
            {BUCKETS.filter((id) => id !== "imported" || hasImported).map((id) => (
              <button
                key={id}
                type="button"
                className="calendar-filter-choice"
                aria-pressed={enabled.includes(id)}
                onClick={() => toggleBucket(id)}
              >
                <i style={{ background: BUCKET_META[id].dark }} aria-hidden="true">
                  {enabled.includes(id) ? <Check size={11} strokeWidth={3} /> : null}
                </i>
                {BUCKET_META[id].name}
                <span>{bucketCounts.get(id) || 0}</span>
              </button>
            ))}
          </div>
          <footer>
            <button type="button" className="calendar-filter-choice" aria-pressed={onlyRelated} onClick={() => setOnlyRelated((value) => !value)}>
              <SlidersHorizontal size={15} aria-hidden="true" />
              仅看相关
              {onlyRelated && unrelatedCount > 0 ? <span>{unrelatedCount}</span> : null}
            </button>
            {hiddenIds.length > 0 ? (
              <button type="button" className="calendar-filter-choice" onClick={unhideAll}>
                恢复已隐藏的 {hiddenIds.length} 条
              </button>
            ) : null}
          </footer>
        </div>
      </dialog>

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
