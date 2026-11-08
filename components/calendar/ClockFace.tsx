"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, Coffee } from "lucide-react";
import type { AgendaEvent, AgendaVisual } from "@/lib/agenda";
import { dateKey, durationMinutes } from "@/lib/agenda";
import { AnimatedBackground } from "./ui/AnimatedBackground";
import { SlidingNumber } from "./ui/SlidingNumber";
import { useReducedMotion } from "./ui/useMotionPreference";

export const VISUAL_META: Record<
  AgendaVisual,
  { name: string; color: string; dark: string; bg: string }
> = {
  course: { name: "课程", color: "#7284EB", dark: "#3D4FA7", bg: "#EEF1FF" },
  ddl: { name: "作业", color: "#E2A33C", dark: "#9A6A17", bg: "#FFF5E4" },
  notice: { name: "校园", color: "#EC8955", dark: "#A44B1C", bg: "#FFF1E7" },
  personal: { name: "个人", color: "#A58BD8", dark: "#72549E", bg: "#F3EEFB" },
};

function toHour(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h + m / 60;
}

function point(hour: number, r = 156) {
  const angle = (hour / 12) * Math.PI * 2 - Math.PI / 2;
  // 固定两位小数：浮点尾差会让服务端与客户端产出不同字符串，触发 hydration 警告
  return { x: round(200 + Math.cos(angle) * r), y: round(200 + Math.sin(angle) * r) };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function arcPath(start: number, end: number, r: number) {
  const a = point(start, r);
  const b = point(end, r);
  // 跨过 12 小时或首尾相接时用大弧，避免画出反向的短弧
  const large = end - start > 6 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

export default function ClockFace({
  events,
  selected,
  onSelect,
  instant = false,
}: {
  events: AgendaEvent[];
  selected: Date;
  onSelect: (event: AgendaEvent) => void;
  instant?: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [period, setPeriod] = useState("pm");
  const [hovered, setHovered] = useState<string | null>(null);
  const preference = useReducedMotion();
  const reduced = preference || instant;

  // 首帧不渲染时间，避免服务端与客户端时间不一致造成 hydration 报错
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const start = period === "am" ? 0 : 12;
  const isToday = dateKey(selected) === dateKey(new Date());

  const visible = events.filter((event) => {
    if (event.allDay) return true;
    const s = toHour(event.start);
    const e = Math.max(toHour(event.end), s + 0.05);
    return s < start + 12 && e > start;
  });

  const picked = events.find((event) => event.id === hovered);
  const currentHour = now ? now.getHours() + now.getMinutes() / 60 : 0;
  const nextEvent =
    events.find((event) => !isToday || toHour(event.end) > currentHour) ?? events[0];

  const hands = now
    ? [
        { angle: (now.getHours() % 12) * 30 + now.getMinutes() * 0.5, r: 64, width: 4 },
        { angle: now.getMinutes() * 6 + now.getSeconds() * 0.1, r: 98, width: 2 },
        { angle: now.getSeconds() * 6, r: 113, width: 1 },
      ]
    : [];

  return (
    <section className="clock-card">
      <div className="clock-card-top">
        <span>
          <span className="live-dot" />
          时间正在发生
        </span>
        <div className="period-switch" aria-label="日程环时段">
          <AnimatedBackground
            defaultValue={period}
            onValueChange={(id) => {
              if (id === "am" || id === "pm") setPeriod(id);
            }}
            className="period-highlight"
          >
            {[
              ["am", "上午"],
              ["pm", "下午"],
            ].map(([id, label]) => (
              <button key={id} data-id={id} type="button" aria-pressed={period === id}>
                {label}
              </button>
            ))}
          </AnimatedBackground>
        </div>
      </div>

      <div className="clock-face-wrap">
        <svg
          className="clock-svg"
          viewBox="0 0 400 400"
          role="img"
          aria-label="实时时钟，日程环显示所选日期的上午或下午安排"
        >
          <circle cx="200" cy="200" r="177" fill="none" stroke="#DCE0EA" strokeWidth=".8" />
          <circle cx="200" cy="200" r="160" fill="none" stroke="#F0F1F7" strokeWidth="13" />

          {Array.from({ length: 60 }, (_, i) => {
            const a = point(i / 5, i % 5 ? 139 : 135);
            const b = point(i / 5, 143);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={i % 5 ? "#C9CDDB" : "#7C839B"}
                strokeWidth={i % 5 ? 1 : 2}
              />
            );
          })}

          {Array.from({ length: 12 }, (_, i) => {
            const p = point(i, 115);
            return (
              <text key={i} x={p.x} y={p.y + 5} textAnchor="middle" className={i % 3 === 0 ? "major-number" : ""}>
                {i || 12}
              </text>
            );
          })}

          {visible.map((event, i) => {
            const s = event.allDay ? start : Math.max(start, toHour(event.start));
            const rawEnd = event.allDay ? start + 12 : toHour(event.end);
            const e = Math.min(start + 11.999, Math.max(rawEnd, s + 0.15));
            const radius = 158 + (i * 12) / Math.max(visible.length, 1);
            const meta = VISUAL_META[event.visual];
            return (
              <motion.path
                key={event.id + period}
                d={arcPath(s, e, radius)}
                fill="none"
                stroke={meta.color}
                strokeWidth={hovered === event.id ? 17 : 11}
                strokeLinecap="round"
                initial={{ pathLength: reduced ? 1 : 0 }}
                animate={{ pathLength: 1, opacity: hovered && hovered !== event.id ? 0.35 : 1 }}
                transition={{ duration: reduced ? 0 : 0.28 }}
                tabIndex={0}
                role="button"
                aria-label={`${event.title} ${event.start}至${event.end}`}
                onMouseEnter={() => setHovered(event.id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(event.id)}
                onBlur={() => setHovered(null)}
                onClick={() => onSelect(event)}
                onKeyDown={(evt) => {
                  if (evt.key === "Enter" || evt.key === " ") {
                    evt.preventDefault();
                    onSelect(event);
                  }
                }}
                className="clock-arc"
              />
            );
          })}

          <text x="200" y="248" textAnchor="middle" className="clock-center-label">
            现在的时间
          </text>

          {now
            ? hands.map((hand, i) => (
                <line
                  key={i}
                  x1="200"
                  y1={i === 2 ? "216" : "200"}
                  x2="200"
                  y2={200 - hand.r}
                  transform={`rotate(${hand.angle} 200 200)`}
                  stroke={i === 2 ? "#ED804A" : "#363D5F"}
                  strokeWidth={hand.width}
                  strokeLinecap="round"
                />
              ))
            : null}
          <circle cx="200" cy="200" r="6" fill="#FFFFFF" stroke="#363D5F" strokeWidth="2" />
        </svg>

        <div
          className="digital-clock"
          role="timer"
          aria-live="off"
          aria-label={now ? now.toLocaleTimeString("zh-CN") : "当前时间"}
        >
          {now ? (
            <>
              <SlidingNumber value={now.getHours()} padStart />
              <span>:</span>
              <SlidingNumber value={now.getMinutes()} padStart />
              <span className="digital-seconds">
                <SlidingNumber value={now.getSeconds()} padStart />
              </span>
            </>
          ) : (
            <span className="digital-placeholder">--:--</span>
          )}
        </div>
      </div>

      <div className="clock-legend">
        {(["course", "ddl", "notice", "personal"] as AgendaVisual[]).map((key) => (
          <span key={key}>
            <i style={{ background: VISUAL_META[key].color }} />
            {VISUAL_META[key].name}
          </span>
        ))}
      </div>

      <div className="clock-bottom">
        <div>
          <strong>
            {picked
              ? picked.title
              : nextEvent
                ? `下一件 · ${nextEvent.title}`
                : "今天的安排，已告一段落。"}
          </strong>
          <span>
            {picked
              ? `${picked.start}–${picked.end}${picked.location ? ` · ${picked.location}` : ""}`
              : `${selected.getMonth() + 1}月${selected.getDate()}日 · ${
                  period === "am" ? "00:00–12:00" : "12:00–24:00"
                } · 点击弧带查看日程`}
          </span>
        </div>
        <ArrowUpRight size={23} />
      </div>
    </section>
  );
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
        <span>{event.allDay ? "　" : event.end}</span>
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
        <p>{event.location || "未设置地点"}</p>
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
