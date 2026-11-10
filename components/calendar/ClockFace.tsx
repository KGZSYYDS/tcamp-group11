"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Coffee, ChevronLeft, ChevronRight } from "lucide-react";
import type { AgendaEvent, AgendaVisual } from "@/lib/agenda";
import { agendaTimeLabel, dateKey, durationMinutes } from "@/lib/agenda";
import { orbitTracks } from "@/lib/orbit";
import { SlidingNumber } from "./ui/SlidingNumber";
import { useReducedMotion } from "./ui/useMotionPreference";

export const VISUAL_META: Record<AgendaVisual, { name: string; color: string; dark: string; bg: string }> = {
  course: { name: "课程", color: "var(--course)", dark: "var(--course-ink)", bg: "var(--course-bg)" },
  ddl: { name: "作业", color: "var(--ddl)", dark: "var(--ddl-ink)", bg: "var(--ddl-bg)" },
  notice: { name: "校园", color: "var(--notice)", dark: "var(--notice-ink)", bg: "var(--notice-bg)" },
  imported: { name: "导入", color: "var(--imported)", dark: "var(--imported-ink)", bg: "var(--imported-bg)" },
  personal: { name: "个人", color: "var(--personal)", dark: "var(--personal-ink)", bg: "var(--personal-bg)" },
};
const round = (v: number) => Math.round(v * 100) / 100;
function point(minute: number, r: number) {
  const a = minute / 1440 * Math.PI * 2 - Math.PI / 2;
  return { x: round(200 + Math.cos(a) * r), y: round(200 + Math.sin(a) * r) };
}
function arc(start: number, end: number, r: number) {
  const a = point(start, r), b = point(Math.min(end, start + 1439.99), r);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${end - start > 720 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

export default function ClockFace({ events, selected, onSelect, instant = false }: {
  events: AgendaEvent[]; selected: Date; onSelect: (event: AgendaEvent) => void; instant?: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [hovered, setHovered] = useState<AgendaEvent | null>(null);
  const [page, setPage] = useState(0);
  const preference = useReducedMotion(), reduced = preference || instant;
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setPage(0); setHovered(null); }, [events, selected]);
  const tracks = useMemo(() => orbitTracks(events), [events]);
  const lanes = Math.max(1, ...tracks.map(t => t.lane + 1));
  const pages = Math.ceil(lanes / 4), activePage = Math.min(page, pages - 1);
  const visible = tracks.filter(t => Math.floor(t.lane / 4) === activePage);
  const allDay = events.filter(e => e.allDay);
  const isToday = now && dateKey(now) === dateKey(selected);
  const minute = now ? now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 : 0;
  const marker = point(minute, 173), lineStart = point(minute, 105);
  return <section className="clock-card orbit-card">
    <div className="clock-card-top"><span><i className="live-dot" />一日轨迹</span><span className="orbit-format">24H / {isToday ? "此刻" : `${selected.getMonth()+1}.${selected.getDate()}`}</span></div>
    <div className="orbit-dial">
      <svg viewBox="0 0 400 400" className="orbit-svg" aria-label="24 小时日程表盘，点击色带查看日程">
        <circle cx="200" cy="200" r="176" className="orbit-outline" />
        {Array.from({ length: 96 }, (_, i) => {
          const a = point(i * 15, 177), b = point(i * 15, i % 4 === 0 ? 184 : 180);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={i % 4 === 0 ? "orbit-tick major" : "orbit-tick"} />;
        })}
        {Array.from({ length: 8 }, (_, i) => { const p = point(i * 180, 194); return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central">{String(i * 3).padStart(2,"0")}</text>; })}
        {[0,1,2,3].map(i => <circle key={i} cx="200" cy="200" r={161-i*15} className="orbit-track" />)}
        {visible.map(({ event, start, end, lane }) => <motion.path key={event.id} d={arc(start + Math.min(1, (end-start)/8), end - Math.min(1, (end-start)/8), 161-(lane%4)*15)}
          fill="none" stroke={VISUAL_META[event.visual].color} strokeWidth={hovered?.id === event.id ? 11 : 8} strokeLinecap="butt"
          className="orbit-event" tabIndex={0} role="button" aria-label={`${event.title}，${agendaTimeLabel(event)}`}
          initial={{ pathLength: reduced ? 1 : 0, opacity: 1 }} animate={{ pathLength: 1, opacity: hovered && hovered.id !== event.id ? .35 : 1 }}
          transition={{ duration: reduced ? 0 : .55, ease: [.22,1,.36,1] }}
          onMouseEnter={() => setHovered(event)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(event)} onBlur={() => setHovered(null)}
          onClick={() => onSelect(event)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(event); } }}>
          <title>{agendaTimeLabel(event)} · {event.title}</title>
        </motion.path>)}
        {isToday && <g className="orbit-now" pointerEvents="none"><line x1={lineStart.x} y1={lineStart.y} x2={marker.x} y2={marker.y} /><circle cx={marker.x} cy={marker.y} r="4" /></g>}
      </svg>
      <div className="orbit-center"><span>{isToday ? "正在发生的今天" : `${selected.getMonth()+1} 月 ${selected.getDate()} 日`}</span>
        <div className="orbit-time" aria-label={now ? `${now.getHours()}:${String(now.getMinutes()).padStart(2,"0")}` : "正在读取时间"}>{now ? <><SlidingNumber value={now.getHours()} padStart /><b>:</b><SlidingNumber value={now.getMinutes()} padStart /></> : "--:--"}</div>
        <span>{isToday ? "一圈，是完整的一天" : "当前时间 · 当日计划"}</span>
        <div className="orbit-center-mark">✦</div>
      </div>
    </div>
    <div className="orbit-caption" aria-live="polite">{hovered ? <><strong>{agendaTimeLabel(hovered)}</strong><span>{hovered.title}</span></> : <><strong>{tracks.length} 项定时安排</strong><span>色带表示时长 · 截止用短标记</span></>}</div>
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
  return (
    <motion.button
      type="button"
      className={`event-row${event.done ? " is-done" : ""}`}
      onClick={onClick}
      whileTap={{ scale: 0.985 }}
      style={
        {
          "--event-color": meta.dark,
          "--event-bg": meta.bg,
        } as React.CSSProperties
      }
    >
      <div className="event-time">
        <strong>{event.allDay ? "全天" : event.start}</strong>
        <span>{event.allDay ? "　" : event.rawKind === "deadline" ? "截止" : event.end}</span>
      </div>
      <div className="event-symbol">
        <span className="event-symbol-letter">{meta.name.slice(0, 1)}</span>
      </div>
      <div className="event-info">
        <span className="event-type">
          {meta.name}
          {event.source ? ` · ${event.source}` : ""}
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
