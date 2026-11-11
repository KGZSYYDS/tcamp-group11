"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { Coffee, ChevronLeft, ChevronRight } from "lucide-react";
import type { AgendaEvent, AgendaVisual } from "@/lib/agenda";
import { agendaTimeLabel, boardCategoryLabel, dateKey, durationMinutes, relevanceHint } from "@/lib/agenda";
import { hasExplicitClock } from "@/lib/deadline.mjs";
import { orbitTracks } from "@/lib/orbit";
import { SlidingNumber } from "./ui/SlidingNumber";
import { useReducedMotion } from "./ui/useMotionPreference";
import { ORBIT_HOURS, ORBIT_MAJOR_TICKS, ORBIT_MINOR_TICKS, ORBIT_RIM, orbitBand, orbitPoint, useOrbitWave } from "./useOrbitWave";

export const VISUAL_META: Record<AgendaVisual, { name: string; color: string; dark: string; bg: string }> = {
  course: { name: "课程", color: "var(--course)", dark: "var(--course-ink)", bg: "var(--course-bg)" },
  ddl: { name: "作业", color: "var(--ddl)", dark: "var(--ddl-ink)", bg: "var(--ddl-bg)" },
  notice: { name: "校园", color: "var(--notice)", dark: "var(--notice-ink)", bg: "var(--notice-bg)" },
  imported: { name: "导入", color: "var(--imported)", dark: "var(--imported-ink)", bg: "var(--imported-bg)" },
  personal: { name: "个人", color: "var(--personal)", dark: "var(--personal-ink)", bg: "var(--personal-bg)" },
};
const SECTOR_MINUTES = 180;
const RIM_RADIUS = 176;
const TOUCH_FALLOFF = 84;
const TOUCH_RELEASE_MS = 140;
const sectors = Array.from({ length: 8 }, (_, index) => {
  const minute = index * SECTOR_MINUTES;
  const start = minute - SECTOR_MINUTES / 2;
  return { minute, start, end: start + SECTOR_MINUTES };
});
type OrbitTrack = ReturnType<typeof orbitTracks>[number];
type RailPosition = { left: number; top: number; width: number };
type TouchPress = { id: string; pointerId: number; x: number; y: number; canOpen: boolean };

function rimStrength(radius: number, touch: boolean) {
  const core = touch ? 36 : 26;
  const edge = touch ? TOUCH_FALLOFF : 68;
  const proximity = (edge - Math.abs(radius - RIM_RADIUS)) / (edge - core);
  const strength = Math.max(0, Math.min(1, proximity));
  return strength * strength * (3 - 2 * strength);
}

function touchesSector(track: OrbitTrack, sector: number) {
  const { start, end } = sectors[sector];
  return (track.start < end && track.end > start) ||
    (start < 0 && track.end > start + 1440);
}

function labelPosition(dial: HTMLDivElement, sector: number): RailPosition | null {
  const rect = dial.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  // 窄屏把标题放到表盘旁的可滚动区，留出完整的点击宽度。
  if (viewportWidth <= 700 || !rect.width) return null;
  // 标题面板放在触发区之外，避免它刚出现就盖住指针所在的边缘。
  const gap = rect.width * (RIM_RADIUS + TOUCH_FALLOFF - 200) / 400 + 8;
  const leftSpace = rect.left - gap - 10;
  const rightSpace = viewportWidth - rect.right - gap - 10;
  const anchor = orbitPoint(sectors[sector].minute, RIM_RADIUS);
  const left = leftSpace >= 120 && (anchor.x < 200 || rightSpace < 120 ||
    (anchor.x === 200 && leftSpace > rightSpace));
  const width = Math.min(204, Math.floor(left ? leftSpace : rightSpace));
  if (width < 120) return null;
  const top = rect.top + anchor.y * rect.height / 400 - 22;
  return {
    left: left ? rect.left - width - gap : rect.right + gap,
    top: Math.max(10, Math.min(top, window.innerHeight - 240)),
    width,
  };
}

export default function ClockFace({ events, selected, onSelect, instant = false, isActive = true }: {
  events: AgendaEvent[]; selected: Date; onSelect: (event: AgendaEvent) => void; instant?: boolean; isActive?: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [page, setPage] = useState(0);
  const [sector, setSector] = useState<number | null>(null);
  const [rail, setRail] = useState<RailPosition | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dial = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const rimBounds = useRef<DOMRect | null>(null);
  const floatingLabels = useRef<HTMLDivElement>(null);
  const hoverIntent = useRef<{ sector: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const touchRelease = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchPress = useRef<TouchPress | null>(null);
  const preference = useReducedMotion(), reduced = preference || instant;
  const selectedDay = dateKey(selected);
  const tracks = useMemo(() => orbitTracks(events), [events]);
  const lanes = Math.max(1, ...tracks.map(t => t.lane + 1));
  const pages = Math.ceil(lanes / 4), activePage = Math.min(page, pages - 1);
  const visible = useMemo(() => tracks.filter(t => Math.floor(t.lane / 4) === activePage), [tracks, activePage]);
  const bands = useMemo(() => visible.map(({ event, start, end, lane }) => orbitBand(event.id, start, end, lane)), [visible]);
  const wave = useOrbitWave(svg, bands, preference);

  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    setPage(0);
    setSector(null);
    rimBounds.current = null;
    wave.current?.(null, true);
    return () => {
      clearTimeout(hoverIntent.current?.timer);
      hoverIntent.current = null;
      clearTimeout(touchRelease.current);
    };
  }, [isActive, selectedDay, wave]);

  useEffect(() => {
    const target = svg.current;
    if (!target) return;
    const invalidate = () => { rimBounds.current = null; };
    const observer = new ResizeObserver(invalidate);
    observer.observe(target);
    window.addEventListener("scroll", invalidate, true);
    window.addEventListener("resize", invalidate);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", invalidate, true);
      window.removeEventListener("resize", invalidate);
    };
  }, []);

  useEffect(() => {
    if (sector === null) return;
    function dismiss() {
      clearTimeout(hoverIntent.current?.timer);
      hoverIntent.current = null;
      clearTimeout(touchRelease.current);
      setSector(null);
      wave.current?.(null);
    }
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (!stage.current?.contains(event.target) && !floatingLabels.current?.contains(event.target)) dismiss();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") dismiss();
    }
    function reposition() {
      if (!dial.current || sector === null) return;
      const next = labelPosition(dial.current, sector);
      setRail((previous) => previous?.left === next?.left && previous?.top === next?.top &&
        previous?.width === next?.width ? previous : next);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [sector, wave]);

  const nearby = sector === null ? [] : visible.filter(track => touchesSector(track, sector));
  const nearbyIds = new Set(nearby.map(track => track.event.id));
  const allDay = events.filter(e => e.allDay);
  const isToday = now && dateKey(now) === selectedDay;
  const minute = now ? now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 : 0;
  const marker = orbitPoint(minute, 173), lineStart = orbitPoint(minute, 105);

  function cancelHoverIntent() {
    clearTimeout(hoverIntent.current?.timer);
    hoverIntent.current = null;
  }

  function reveal(next: number) {
    cancelHoverIntent();
    if (next === sector) return;
    setRail(dial.current ? labelPosition(dial.current, next) : null);
    setHighlighted(null);
    setSector(next);
  }

  function releaseRim(delay = 0) {
    cancelHoverIntent();
    clearTimeout(touchRelease.current);
    if (delay) touchRelease.current = setTimeout(() => wave.current?.(null), delay);
    else wave.current?.(null);
  }

  function handleRim(event: ReactPointerEvent<SVGSVGElement>) {
    if (!event.isPrimary) return;
    const touch = event.pointerType === "touch";
    if (touch) clearTimeout(touchRelease.current);
    const press = touchPress.current;
    if (event.type === "pointermove" && touch && press?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press.canOpen = false;
    const target = event.target instanceof Element ? event.target.closest("[data-orbit-event]") : null;
    const targetId = target?.getAttribute("data-orbit-event");
    const rect = rimBounds.current ??= event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) * 400 / rect.width - 200;
    const y = (event.clientY - rect.top) * 400 / rect.height - 200;
    const strength = targetId && event.type === "pointerdown" ? 1 : rimStrength(Math.hypot(x, y), touch);
    const minute = (Math.atan2(y, x) * 720 / Math.PI + 1800) % 1440;
    wave.current?.(strength ? { minute, strength } : null);
    if ((!targetId && strength < 0.28) || (targetId && nearbyIds.has(targetId))) {
      cancelHoverIntent();
      return;
    }
    const next = Math.floor((minute + SECTOR_MINUTES / 2) / SECTOR_MINUTES) % sectors.length;
    if (event.pointerType !== "mouse" || sector === null || event.type === "pointerdown") {
      reveal(next);
    } else if (next === sector) {
      cancelHoverIntent();
    } else if (hoverIntent.current?.sector !== next) {
      cancelHoverIntent();
      // 跨过相邻刻度去点标题时，不立刻切换当前区段。
      hoverIntent.current = { sector: next, timer: setTimeout(() => reveal(next), 180) };
    }
  }

  function openEvent(event: AgendaEvent) {
    releaseRim();
    setSector(null);
    onSelect(event);
  }

  function startPress(pointer: ReactPointerEvent, event: AgendaEvent, canOpen: boolean) {
    touchPress.current = pointer.pointerType === "touch" ? {
      id: event.id, pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY, canOpen,
    } : null;
  }

  function finishPress(pointer: ReactPointerEvent, event: AgendaEvent) {
    const press = touchPress.current;
    if (pointer.pointerType === "touch" && press?.id === event.id &&
      press.pointerId === pointer.pointerId && press.canOpen &&
      Math.hypot(pointer.clientX - press.x, pointer.clientY - press.y) <= 12) {
      openEvent(event);
    }
  }

  function clickEvent(click: ReactMouseEvent, event: AgendaEvent) {
    // 触摸用 pointerup 区分点按和滑动，避免滑动后浏览器吞掉合成 click。
    if (click.detail && touchPress.current?.id === event.id) return;
    openEvent(event);
  }

  const labels = nearby.length > 0 && (
    <div
      ref={rail ? floatingLabels : undefined}
      className={rail ? "orbit-labels orbit-labels-floating" : "orbit-labels orbit-labels-inline"}
      style={rail || undefined}
      role="group"
      aria-label="当前区段事项"
    >
      {nearby.map(({ event }) => (
        <button
          key={event.id}
          type="button"
          className="orbit-label"
          data-highlighted={highlighted === event.id || undefined}
          onPointerEnter={() => setHighlighted(event.id)}
          onPointerLeave={() => setHighlighted(null)}
          onFocus={() => setHighlighted(event.id)}
          onBlur={() => setHighlighted(null)}
          onPointerDown={(e) => startPress(e, event, true)}
          onPointerUp={(e) => finishPress(e, event)}
          onClick={(e) => clickEvent(e, event)}
        >
          <i style={{ background: VISUAL_META[event.visual].color }} aria-hidden="true" />
          <span><small>{agendaTimeLabel(event)}</small>{event.title}</span>
        </button>
      ))}
    </div>
  );

  return <section className="clock-card orbit-card">
    <div className="clock-card-top"><span><i className="live-dot" />一日轨迹</span><span className="orbit-format">24H / {isToday ? "此刻" : `${selected.getMonth()+1}.${selected.getDate()}`}</span></div>
    <div ref={stage} className="orbit-stage">
      <div ref={dial} className="orbit-dial">
        <svg
          ref={svg}
          viewBox="0 0 400 400"
          className="orbit-svg"
          aria-label="24 小时日程表盘，触碰边框查看当前区段"
          onPointerMove={handleRim}
          onPointerDown={handleRim}
          onPointerUp={(event) => {
            if (event.isPrimary && event.pointerType === "touch") releaseRim(TOUCH_RELEASE_MS);
          }}
          onPointerLeave={(event) => {
            rimBounds.current = null;
            if (event.pointerType !== "touch") releaseRim();
          }}
          onPointerCancel={() => releaseRim()}
        >
          <circle cx="200" cy="200" r={RIM_RADIUS} fill="none" stroke="transparent"
            strokeWidth={2 * TOUCH_FALLOFF} pointerEvents="stroke" aria-hidden="true" />
          <path d={ORBIT_RIM} className="orbit-outline" />
          <path d={ORBIT_MINOR_TICKS} className="orbit-tick" />
          <path d={ORBIT_MAJOR_TICKS} className="orbit-tick major" />
          {ORBIT_HOURS.map(({ minute }, index) => {
            const label = orbitPoint(minute, 194);
            return (
              <text key={minute} data-orbit-hour="" x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central">
                {String(index * 3).padStart(2, "0")}
              </text>
            );
          })}
          {[0,1,2,3].map(i => <circle key={i} cx="200" cy="200" r={161-i*15} className="orbit-track" />)}
          {visible.map(({ event, start, end }, index) => {
            const path = bands[index].rest;
            const active = nearbyIds.has(event.id);
            return (
              <g
                key={event.id}
                className="orbit-event"
                data-orbit-event={event.id}
                data-nearby={active || undefined}
                tabIndex={0}
                role="button"
                aria-label={`${event.title}，${agendaTimeLabel(event)}`}
                onPointerDown={(e) => startPress(e, event, active)}
                onPointerUp={(e) => finishPress(e, event)}
                onPointerEnter={() => setHighlighted(event.id)}
                onPointerLeave={() => setHighlighted(null)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible") && !active) {
                    const minute = (start + end) / 2;
                    wave.current?.({ minute, strength: 1 });
                    reveal(Math.floor((minute + SECTOR_MINUTES / 2) / SECTOR_MINUTES) % sectors.length);
                  }
                }}
                onClick={(e) => clickEvent(e, event)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEvent(event);
                  }
                }}
              >
                <path d={path} fill="none" stroke="transparent" strokeWidth={active ? 18 : 14} />
                <motion.path d={path} className="orbit-event-stroke" fill="none"
                  stroke={VISUAL_META[event.visual].color} strokeWidth={active && highlighted === event.id ? 11 : 8}
                  strokeLinecap="butt" pointerEvents="none" initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }} transition={{ duration: reduced ? 0 : .55, ease: [.22, 1, .36, 1] }} />
              </g>
            );
          })}
          {isToday && <g className="orbit-now" pointerEvents="none"><line x1={lineStart.x} y1={lineStart.y} x2={marker.x} y2={marker.y} /><circle cx={marker.x} cy={marker.y} r="4" /></g>}
        </svg>
        <div className="orbit-center"><span>{isToday ? "正在发生的今天" : `${selected.getMonth()+1} 月 ${selected.getDate()} 日`}</span>
          <div className="orbit-time" aria-label={now ? `${now.getHours()}:${String(now.getMinutes()).padStart(2,"0")}` : "正在读取时间"}>{now ? <><SlidingNumber value={now.getHours()} padStart /><b>:</b><SlidingNumber value={now.getMinutes()} padStart /></> : "--:--"}</div>
          <span>{isToday ? "一圈，是完整的一天" : "当前时间 · 当日计划"}</span>
          <div className="orbit-center-mark">✦</div>
        </div>
      </div>
      {!rail && labels}
    </div>
    {isActive && rail && labels && createPortal(labels, document.body)}
    <div className="orbit-caption"><strong>{tracks.length} 项定时安排</strong><span>色带表示时长 · 截止用短标记</span></div>
    {pages > 1 && <div className="orbit-pagination"><button aria-label="上一组轨道" disabled={!activePage} onClick={() => setPage(activePage-1)}><ChevronLeft size={15}/></button><span>轨道组 {activePage+1} / {pages} · 本组 {visible.length} 项</span><button aria-label="下一组轨道" disabled={activePage === pages-1} onClick={() => setPage(activePage+1)}><ChevronRight size={15}/></button></div>}
    <div className="clock-legend">{Object.entries(VISUAL_META).filter(([key]) => key !== "imported" || events.some((event) => event.visual === key)).map(([key, meta]) => <span key={key}><i style={{ background: meta.color }}/>{meta.name}</span>)}</div>
    {allDay.length > 0 && <details className="all-day-tray"><summary>全天事项 <b>{allDay.length}</b><span>展开查看</span></summary><div>{allDay.map(e => <button key={e.id} onClick={() => onSelect(e)}>{e.title}<span>↗</span></button>)}</div></details>}
  </section>;
}

export function EventRow({
  event,
  onClick,
}: {
  event: AgendaEvent;
  onClick: () => void;
}) {
  const meta = VISUAL_META[event.visual];
  const minutes = durationMinutes(event);
  const source = boardCategoryLabel(event) || event.source;
  /**
   * 只写了日期的公文通截止，库里存的是 23:59（排序用），不是真实时刻。
   * 直接显示会变成「23:59 / 截止」，让人以为通知要求 23:59 前交。
   */
  const dateOnlyDeadline = event.rawKind === "deadline" && !event.allDay && !hasExplicitClock(event.note);
  return (
    <motion.button
      type="button"
      className={`event-row${event.done ? " is-done" : ""}`}
      onClick={onClick}
      title={relevanceHint(event)}
      whileTap={{ scale: 0.985 }}
      style={
        {
          "--event-color": meta.dark,
          "--event-bg": meta.bg,
        } as React.CSSProperties
      }
    >
      <div className="event-time">
        <strong>{event.allDay ? "全天" : dateOnlyDeadline ? "截止" : event.start}</strong>
        <span>
          {event.allDay
            ? "　"
            : event.rawKind === "deadline"
              ? dateOnlyDeadline
                ? "当天"
                : "截止"
              : event.end}
        </span>
      </div>
      <div className="event-symbol">
        <span className="event-symbol-letter">{meta.name.slice(0, 1)}</span>
      </div>
      <div className="event-info">
        <span className="event-type">
          {meta.name}
          {source ? ` · ${source}` : ""}
          {minutes > 0 && !event.allDay ? ` · ${minutes} 分钟` : ""}
        </span>
        <h3>{event.title}</h3>
        {event.location && <p>{event.location}</p>}
      </div>
      <span className="event-chevron" aria-hidden="true">
        ›
      </span>
    </motion.button>
  );
}

export function EmptyDay({ hint }: { hint: string }) {
  return (
    <div className="empty">
      <Coffee />
      <h3>今天的留白，交给你</h3>
      <p>{hint}</p>
    </div>
  );
}
