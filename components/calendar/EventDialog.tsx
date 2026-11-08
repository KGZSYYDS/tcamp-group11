"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Clock3, MapPin, Plus, Search, Sparkles, X } from "lucide-react";
import type { AgendaEvent } from "@/lib/agenda";
import { dateKey } from "@/lib/agenda";
import { VISUAL_META } from "./ClockFace";

export type DialogKind = "detail" | "add" | "edit" | "search";

export interface DialogState {
  kind: DialogKind;
  event?: AgendaEvent;
}

interface DialogProps {
  state: DialogState | null;
  onClose: () => void;
  onSave: (data: EventFormData) => Promise<void>;
  onDelete: (event: AgendaEvent) => Promise<void>;
  search: (query: string) => AgendaEvent[];
  onSelect: (event: AgendaEvent) => void;
  submitting: boolean;
  error: string;
}

export interface EventFormData {
  kind: "exam" | "pe" | "activity" | "other";
  title: string;
  date: string;
  start: string;
  end: string;
  location: string;
  note: string;
  course: string;
  scope: string;
}

const KIND_OPTIONS = [
  { value: "exam", label: "考试" },
  { value: "activity", label: "活动" },
  { value: "pe", label: "体测" },
  { value: "other", label: "其他" },
] as const;

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

export default function EventDialog({
  state,
  onClose,
  onSave,
  onDelete,
  search,
  onSelect,
  submitting,
  error,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (state) {
      if (!node.open) node.showModal();
    } else if (node.open) {
      node.close();
    }
  }, [state]);

  // 关闭对话框时重置搜索词与表单错误，避免下次打开残留
  useEffect(() => {
    if (!state) {
      setQuery("");
      setFormError("");
    }
  }, [state]);

  const results = query.trim() ? search(query).slice(0, 30) : [];

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {state ? (
        <div className="dialog-body">
          <div className="dialog-top">
            <span>
              深大日程 ·{" "}
              {state.kind === "detail"
                ? "日程详情"
                : state.kind === "add"
                  ? "新建日程"
                  : state.kind === "edit"
                    ? "编辑日程"
                    : "搜索日程"}
            </span>
            <IconButton label="关闭" onClick={onClose}>
              <X size={21} />
            </IconButton>
          </div>

          {state.kind === "detail" && state.event ? (
            <>
              <div className={`detail-art ${state.event.visual}`}>
                <Clock3 size={44} />
                <span>{state.event.date.slice(5).replace("-", " / ")}</span>
              </div>
              <span className="pill">
                {VISUAL_META[state.event.visual].name}
                {state.event.source ? ` · ${state.event.source}` : ""}
              </span>
              <h2>{state.event.title}</h2>
              <p className="detail-description">{state.event.note || "为这件事留出时间，从容开始。"}</p>
              <div className="detail-meta">
                <p>
                  <Clock3 size={18} />
                  {state.event.date}　{state.event.allDay ? "全天" : `${state.event.start}–${state.event.end}`}
                </p>
                <p>
                  <MapPin size={18} />
                  {state.event.location || "未设置地点"}
                </p>
                {state.event.course ? (
                  <p>
                    <Sparkles size={18} />
                    关联课程 · {state.event.course}
                  </p>
                ) : null}
              </div>
              {state.event.link ? (
                <a className="primary wide" href={state.event.link} target="_blank" rel="noreferrer">
                  打开详情 / 提交入口
                </a>
              ) : null}
              {state.event.deletable ? (
                <div className="detail-actions">
                  <button
                    type="button"
                    className="subtle danger"
                    onClick={() => void onDelete(state.event!)}
                  >
                    删除这条日程
                  </button>
                </div>
              ) : (
                <p className="form-help">这条内容来自公共事件，只有发布者可以删除。</p>
              )}
            </>
          ) : null}

          {state.kind === "add" || state.kind === "edit" ? (
            <EventForm
              key={state.event?.id || "new"}
              event={state.event}
              submitting={submitting}
              error={formError || error}
              onSubmit={async (data) => {
                if (!data.title.trim()) {
                  setFormError("请填写日程名称");
                  return;
                }
                if (data.end <= data.start) {
                  setFormError("结束时间需要晚于开始时间");
                  return;
                }
                setFormError("");
                await onSave(data);
              }}
            />
          ) : null}

          {state.kind === "search" ? (
            <>
              <h2>找一件安排好的事</h2>
              <label className="search-field">
                <Search size={18} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索日程名称或地点"
                  aria-label="搜索关键词"
                  autoFocus
                />
              </label>
              <p className="form-help">搜索全部已加载的日程（考试、作业、签到与个人安排）。</p>
              <div className="search-results">
                {query.trim() && results.length === 0 ? (
                  <div className="empty">
                    <Search />
                    <h3>没有找到相关日程</h3>
                    <p>换一个关键词试试。</p>
                  </div>
                ) : null}
                {results.map((event) => (
                  <button key={event.id} type="button" onClick={() => onSelect(event)}>
                    <h3>{event.title}</h3>
                    <p>
                      {event.date}　{event.allDay ? "全天" : event.start}　
                      {VISUAL_META[event.visual].name}
                    </p>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
                {!query.trim() ? (
                  <div className="empty">
                    <Search />
                    <p>试试「数据库」或「图书馆」</p>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

function EventForm({
  event,
  submitting,
  error,
  onSubmit,
}: {
  event?: AgendaEvent;
  submitting: boolean;
  error: string;
  onSubmit: (data: EventFormData) => Promise<void>;
}) {
  const today = dateKey(new Date());
  const [data, setData] = useState<EventFormData>({
    kind: "other",
    title: event?.title || "",
    date: event?.date || today,
    start: event?.start || "18:00",
    end: event?.end || "19:00",
    location: event?.location || "",
    note: event?.note || "",
    course: event?.course || "",
    scope: event?.scope || "personal",
  });

  function update<K extends keyof EventFormData>(key: K, value: EventFormData[K]) {
    setData((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(data);
      }}
    >
      <h2>{event ? "调整一下安排" : "为想做的事，留点时间。"}</h2>

      <label>
        日程名称
        <input
          value={data.title}
          onChange={(e) => update("title", e.target.value)}
          placeholder="例如，和小组讨论日历原型"
          maxLength={70}
          autoFocus
        />
      </label>

      <label>
        类型
        <select value={data.kind} onChange={(e) => update("kind", e.target.value as EventFormData["kind"])}>
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        日期
        <input type="date" value={data.date} onChange={(e) => update("date", e.target.value)} />
      </label>

      <div className="form-grid">
        <label>
          开始
          <input type="time" value={data.start} onChange={(e) => update("start", e.target.value)} />
        </label>
        <label>
          结束
          <input type="time" value={data.end} onChange={(e) => update("end", e.target.value)} />
        </label>
      </div>

      <label>
        地点
        <input
          value={data.location}
          onChange={(e) => update("location", e.target.value)}
          placeholder="在哪里开始这件事"
          maxLength={80}
        />
      </label>

      <label>
        可见范围
        <select value={data.scope} onChange={(e) => update("scope", e.target.value)}>
          <option value="personal">仅自己</option>
          <option value="school">全校（所有登录用户）</option>
        </select>
      </label>

      <label>
        备注
        <input
          value={data.note}
          onChange={(e) => update("note", e.target.value)}
          placeholder="需要带什么、注意事项等"
          maxLength={120}
        />
      </label>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="primary wide" type="submit" disabled={submitting}>
        <Check size={18} />
        {submitting ? "保存中…" : "保存日程"}
      </button>
    </form>
  );
}

export { IconButton, Plus };
