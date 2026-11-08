"use client";

import { useEffect, useRef, useState } from "react";
import { AlignVerticalJustifyStart, Coffee, MapPin } from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import AnimatedContent from "./ui/AnimatedContent";
import { VISUAL_META } from "./ClockFace";

function addDays(date: Date, n: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

/** 时间轴：向下滚动继续加载未来，上方按钮回看更早 */
export default function TimelineView({
  selected,
  eventsFor,
  onEvent,
}: {
  selected: Date;
  eventsFor: (date: Date) => AgendaEvent[];
  onEvent: (event: AgendaEvent) => void;
}) {
  const [range, setRange] = useState({ start: -1, end: 12 });
  const scroller = useRef<HTMLDivElement>(null);
  const endSentinel = useRef<HTMLDivElement>(null);
  const pendingOffset = useRef<number | null>(null);

  // 向上扩展时保持当前视口位置，避免内容跳动
  useEffect(() => {
    const node = scroller.current;
    if (!node || pendingOffset.current === null) return;
    node.scrollTop += node.scrollHeight - pendingOffset.current;
    pendingOffset.current = null;
  }, [range.start]);

  useEffect(() => {
    const root = scroller.current;
    const sentinel = endSentinel.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRange((prev) => ({ ...prev, end: Math.min(prev.end + 7, 120) }));
        }
      },
      { root, rootMargin: "150px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  function earlier() {
    const node = scroller.current;
    if (node) pendingOffset.current = node.scrollHeight;
    setRange((prev) => ({ ...prev, start: prev.start - 7 }));
  }

  return (
    <section className="timeline-card">
      <div className="timeline-heading">
        <span>
          <AlignVerticalJustifyStart size={18} />
          接下来，值得期待
        </span>
        <span>向下滚动，继续加载未来</span>
      </div>

      <div className="timeline-scroll" ref={scroller}>
        <button type="button" className="load-timeline" onClick={earlier}>
          查看更早的日程
        </button>

        {Array.from({ length: range.end - range.start }, (_, i) => {
          const date = addDays(selected, i + range.start);
          const events = eventsFor(date);
          return (
            <div className="timeline-day" key={dateKey(date)}>
              <div className="timeline-date">
                <span>{date.getMonth() + 1}月</span>
                <strong>{date.getDate()}</strong>
                <small>周{"日一二三四五六"[date.getDay()]}</small>
              </div>
              <div className="timeline-track">
                <i className="timeline-node" />
                {events.length === 0 ? (
                  <p className="timeline-empty">
                    <Coffee size={14} /> 给这一天留一点空白。
                  </p>
                ) : (
                  events.map((event) => {
                    const meta = VISUAL_META[event.visual];
                    return (
                      <AnimatedContent key={event.id} distance={10} duration={0.24} threshold={0}>
                        <button
                          type="button"
                          className={`timeline-event${event.done ? " is-done" : ""}`}
                          onClick={() => onEvent(event)}
                          style={
                            {
                              "--event-color": meta.dark,
                              background: meta.bg,
                            } as React.CSSProperties
                          }
                        >
                          <span>
                            {event.start}—{event.end}
                            <small>{meta.name}</small>
                          </span>
                          <h3>{event.title}</h3>
                          <p>
                            <MapPin size={13} />
                            {event.location || "未设置地点"}
                          </p>
                          <span className="timeline-arrow" aria-hidden="true">
                            ↗
                          </span>
                        </button>
                      </AnimatedContent>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}

        <div ref={endSentinel} className="timeline-sentinel">
          继续向未来
        </div>
      </div>
    </section>
  );
}
