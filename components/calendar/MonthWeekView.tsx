"use client";

import { useState } from "react";
import { minuteOf } from "@/lib/orbit";
import { Coffee } from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey, relevanceHint } from "@/lib/agenda";
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
      <div className="month-board">
      <div className="month-heading">
        <strong>
          {selected.getMonth() + 1}
          <span>月 / {selected.getFullYear()}</span>
        </strong>
        <span>点击日期，展开一天</span>
      </div>

      <div className="month-grid" style={{ gridTemplateRows: `28px repeat(${Math.ceil((((first.getDay()+6)%7) + new Date(selected.getFullYear(), selected.getMonth()+1, 0).getDate())/7)}, minmax(0, 1fr))` }}>
        {"一二三四五六日".split("").map((d) => (
          <div className="weekday" key={d}>
            周{d}
          </div>
        ))}

        {Array.from({ length: Math.ceil((((first.getDay()+6)%7) + new Date(selected.getFullYear(), selected.getMonth()+1, 0).getDate())/7)*7 }, (_, i) => {
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
        <div className="month-selected-scroll">
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

/** A compact full-week overview, with details on demand instead of cropped titles. */
export function WeekView({ selected, eventsFor, onEvent }: ViewProps) {
  const monday = addDays(selected, -((selected.getDay() + 6) % 7));
  const [expanded, setExpanded] = useState<Date | null>(null);
  const marks = [...PERIODS, "20:40"].map(minuteOf);
  function position(time: string) {
    const n = minuteOf(time);
    if (n < marks[0]) return 0;
    if (n >= marks[12]) return 11.7;
    const i = marks.findIndex((m, i) => n >= m && n < marks[i+1]);
    return i + (n - marks[i]) / (marks[i+1] - marks[i]);
  }
  return <section className="week-card">
    <div className="week-info"><span>本周全览 <span className="semester-note">· {monday.getMonth()+1}月{monday.getDate()}日起</span></span><span>点日期查看当天全部事项</span></div>
    <div className="week-scroll"><div className="week-grid">
      <div className="week-label">节次</div>
      {Array.from({length:7}, (_,i) => { const date=addDays(monday,i), list=eventsFor(date), allDay=list.filter(e=>e.allDay); return <button key={i} type="button" onClick={()=>setExpanded(date)} className={`week-label ${dateKey(date)===dateKey(selected)?"selected":""}`} aria-label={`查看周${"一二三四五六日"[i]}全部 ${list.length} 项日程`}><span>周{"一二三四五六日"[i]}</span><strong>{date.getDate()}</strong>{allDay.length>0 && <small>全天 {allDay.length}</small>}</button>; })}
      <div className="period-column">{PERIODS.map((time,i)=><div key={time}><strong>{i+1}</strong><small>{time}</small></div>)}</div>
      {Array.from({length:7},(_,i)=>{
        const dayEvents=eventsFor(addDays(monday,i)).filter(e=>!e.allDay);
        const ends:number[]=[];
        const blocks=dayEvents.map(event=>{const start=position(event.start); const end=event.end<=event.start?Math.min(11.7,start+.5):Math.min(12,Math.max(start+.8,position(event.end)));return {event,start,end};}).sort((a,b)=>a.start-b.start||b.end-a.end).map(item=>{let lane=ends.findIndex(e=>e<=item.start); if(lane<0)lane=ends.length; ends[lane]=item.end;return {...item,lane};});
        return <div className="week-column" key={i}>{blocks.map(({event,start,end,lane})=><button key={event.id} type="button" className="course-block" title={`${event.title} · ${event.start}–${event.end}${event.location?' · '+event.location:''}${relevanceHint(event)?' · '+relevanceHint(event):''}`} onClick={()=>onEvent(event)} style={{top:`${start/12*100}%`,height:`${(end-start)/12*100}%`,left:`calc(${lane/ends.length*100}% + 2px)`,width:`calc(${100/ends.length}% - 4px)`,background:VISUAL_META[event.visual].bg,color:VISUAL_META[event.visual].dark,borderColor:VISUAL_META[event.visual].color}}><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}<span>{event.start}</span></button>)}</div>;
      })}
    </div></div>
    {expanded && <div className="week-day-detail"><div className="section-title"><h3>{expanded.getMonth()+1}月{expanded.getDate()}日 · 全部安排</h3><button className="subtle" onClick={()=>setExpanded(null)}>收起 ×</button></div><div className="week-day-events">{eventsFor(expanded).length?eventsFor(expanded).map(event=><EventRow key={event.id} event={event} onClick={()=>onEvent(event)}/>):<p className="empty">这天还没有安排</p>}</div></div>}
  </section>;
}
