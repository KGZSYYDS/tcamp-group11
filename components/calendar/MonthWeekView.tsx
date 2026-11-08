"use client";

import { motion } from "motion/react";
import { Coffee } from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import { EventRow, VISUAL_META } from "./ClockFace";

function addDays(date: Date, n: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

interface ViewProps {
  selected: Date;
  eventsFor: (date: Date) => AgendaEvent[];
  onEvent: (event: AgendaEvent) => void;
}

/** 月历：点击日期就地更新右侧列表，保持浏览上下文 */
export function MonthView({
  selected,
  eventsFor,
  onDate,
  onEvent,
  onOpenDay,
}: ViewProps & { onDate: (date: Date) => void; onOpenDay: () => void }) {
  const first = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const begin = addDays(first, -((first.getDay() + 6) % 7));
  const todayKey = dateKey(new Date());
  const selectedKey = dateKey(selected);
  const selectedEvents = eventsFor(selected);

  return (
    <section className="month-card">
      <div className="month-heading">
        <strong>
          {selected.getMonth() + 1}
          <span>月 / {selected.getFullYear()}</span>
        </strong>
        <span>点击日期，展开一天</span>
      </div>

      <div className="month-grid">
        {"一二三四五六日".split("").map((d) => (
          <div className="weekday" key={d}>
            周{d}
          </div>
        ))}

        {Array.from({ length: 42 }, (_, i) => {
          const date = addDays(begin, i);
          const key = dateKey(date);
          const events = eventsFor(date);
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;
          return (
            <div
              key={key}
              className={`month-cell ${date.getMonth() !== selected.getMonth() ? "outside" : ""} ${
                isToday ? "is-today" : ""
              } ${isSelected ? "is-selected" : ""}`}
            >
              <button
                type="button"
                className="month-number"
                onClick={() => onDate(date)}
                aria-label={`查看 ${key}`}
                aria-pressed={isSelected}
              >
                {date.getDate()}
                <small>{isToday ? "今天" : ""}</small>
              </button>
              <div className="month-events">
                {events.slice(0, 2).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => onEvent(event)}
                    style={{ background: VISUAL_META[event.visual].bg, color: VISUAL_META[event.visual].dark }}
                  >
                    <i />
                    {event.title}
                  </button>
                ))}
                {events.length > 2 ? (
                  <button type="button" className="month-more" onClick={() => onDate(date)}>
                    +{events.length - 2} 项
                  </button>
                ) : null}
              </div>
              <div className="month-dots">
                {events.slice(0, 3).map((event) => (
                  <i key={event.id} style={{ background: VISUAL_META[event.visual].dark }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="month-selected">
        <div className="section-title">
          <h3>
            {selected.getMonth() + 1}月{selected.getDate()}日的安排
          </h3>
          <button type="button" className="subtle" onClick={onOpenDay}>
            时钟视图 <span aria-hidden="true">↗</span>
          </button>
        </div>
        {selectedEvents.length === 0 ? (
          <div className="empty">
            <Coffee />
            <h3>这天还没有安排</h3>
            <p>点右上角「新建日程」，记下一件想做的事。</p>
          </div>
        ) : null}
        {selectedEvents.map((event) => (
          <EventRow key={event.id} event={event} onClick={() => onEvent(event)} />
        ))}
      </div>
    </section>
  );
}

const PERIODS = [
  "08:30",
  "09:20",
  "10:20",
  "11:10",
  "12:00",
  "12:50",
  "14:00",
  "14:50",
  "15:50",
  "16:40",
  "19:00",
  "19:50",
];

/** 课表：按周铺开，事件按开始时间落到最近的节次 */
export function WeekView({ selected, eventsFor, onEvent }: ViewProps) {
  const monday = addDays(selected, -((selected.getDay() + 6) % 7));
  const subjectColors = ["#EDF0FF", "#E7EEFF", "#FFF0E5", "#F0E9FA"];
  const selectedKey = dateKey(selected);

  function slotOf(start: string) {
    let slot = 0;
    PERIODS.forEach((time, index) => {
      if (time <= start) slot = index;
    });
    return slot;
  }

  return (
    <section className="week-card">
      <div className="week-info">
        <span>
          周视图
          <span className="semester-note"> · {monday.getMonth() + 1}月{monday.getDate()}日起</span>
        </span>
        <span>共 7 天 · 按开始时间归入节次</span>
      </div>

      <div className="week-scroll">
        <div className="week-grid">
          <div className="week-label">节次</div>
          {Array.from({ length: 7 }, (_, i) => {
            const date = addDays(monday, i);
            return (
              <div
                className={`week-label ${dateKey(date) === selectedKey ? "selected" : ""}`}
                key={i}
              >
                <span>周{"一二三四五六日"[i]}</span>
                <strong>{date.getDate()}</strong>
              </div>
            );
          })}

          <div className="period-column">
            {PERIODS.map((time, i) => (
              <div key={time}>
                <strong>{i + 1}</strong>
                <small>{time}</small>
              </div>
            ))}
          </div>

          {Array.from({ length: 7 }, (_, i) => {
            const date = addDays(monday, i);
            const dayEvents = eventsFor(date).filter((event) => !event.allDay);
            return (
              <div className="week-column" key={i}>
                {dayEvents.map((event) => {
                  const slot = slotOf(event.start);
                  const [sh, sm] = event.start.split(":").map(Number);
                  const [eh, em] = event.end.split(":").map(Number);
                  const minutes = Math.max(30, eh * 60 + em - (sh * 60 + sm));
                  const height = Math.max(1, (minutes / 50) * 1.28);
                  const meta = VISUAL_META[event.visual];
                  return (
                    <button
                      key={event.id}
                      type="button"
                      className="course-block"
                      title={`${event.title} · ${event.location} · ${event.start}`}
                      onClick={() => onEvent(event)}
                      style={{
                        top: `${slot * 64 + 3}px`,
                        height: `${Math.min(height, 6) * 64 - 6}px`,
                        background: event.visual === "course" ? subjectColors[i % 4] : meta.bg,
                      }}
                    >
                      <strong>{event.title}</strong>
                      <small>{event.location}</small>
                      <span>{event.start}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
