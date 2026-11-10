import type { CalEvent, Checkin, Ddl, EventKind } from "./types";
import type { MyEvent, PersonalItem, TimetableSession } from "./local-store";

/** 原型视图里的四类日程 */
export type AgendaType = "course" | "notice" | "personal";

/** 视觉类别：三类日程 + 作业截止（与课程同色系但需要单独标识） */
export type AgendaVisual = AgendaType | "ddl";

/**
 * 视图层统一事件结构。
 * 原型的四视图（时钟 / 月历 / 课表 / 时间轴）都消费这一种形状，
 * 而项目后端有三张表（events / ddls / checkins），因此在此处做一次收敛映射，
 * 让界面只依赖稳定结构，后端表结构变化不会传导到视图组件。
 */
export interface AgendaEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  start: string;
  end: string;
  location: string;
  type: AgendaType;
  /** 配色与标签用的视觉类别，ddl 单独标识 */
  visual: AgendaVisual;
  /** 来源标记，例如「签到」「作业」「考试」 */
  source?: string;
  note?: string;
  link?: string;
  allDay?: boolean;
  /** 后端原始类型，删除与跳转时用来判断来源表 */
  rawKind: EventKind | "ddl" | "checkin";
  /** 是否可删除（个人事件或本人创建的公共事件） */
  deletable: boolean;
  scope?: string;
  college?: string;
  grade?: string;
  course?: string;
  /** 已完成的 DDL 用于弱化展示 */
  done?: boolean;
  /** 相关性分数 0–100：同一天内先看得分高的 */
  score?: number;
  /** 打分依据，用于 tooltip 解释为什么排在前面 */
  reasons?: string[];
  /**
   * 筛选分类，由 lib/categorize.mjs 判定：
   * course=课表 / homework=本机待办与签到 / campus=全校通知 / personal=本学院通知
   * other=别的学院的通知（不进任何分类，仅「全部」可见）
   */
  category?: "course" | "homework" | "campus" | "personal" | "other";
}

const KIND_LABEL: Record<EventKind, string> = {
  exam: "考试",
  pe: "体测",
  activity: "活动",
  meeting: "会议",
  deadline: "截止",
  other: "日程",
};

/** 后端事件类型 → 原型三类配色。考试/活动归入校园事项，体测与其它归入个人安排 */
function toAgendaType(kind: EventKind): AgendaType {
  if (kind === "exam" || kind === "activity") return "notice";
  return "personal";
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

export function timeKey(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 把 ISO 字符串安全转成 Date；非法值返回 null，避免一条脏数据让整页崩掉 */
function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** 事件结束时间：优先用 endAt，否则按全天 / 默认 60 分钟推算 */
function resolveEnd(start: Date, endAt: Date | null, allDay: boolean): Date {
  if (endAt && endAt.getTime() > start.getTime()) return endAt;
  // 全天事件到当天 23:59；有钟点但没写结束时间的，就画成一个「点」，
  // 不编造「持续一小时」——那会让日历看起来像是我们自己臆想出来的安排。
  return allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59) : start;
}

export interface MapContext {
  currentUserId?: string;
}

/** events 表 → 视图事件 */
export function mapCalEvent(event: CalEvent, ctx: MapContext = {}): AgendaEvent | null {
  const start = parseDate(event.startAt);
  if (!start) return null;
  const end = event.kind === "deadline" ? start : resolveEnd(start, parseDate(event.endAt), event.allDay);
  const ownerMatch = Boolean(ctx.currentUserId && event.ownerId === ctx.currentUserId);
  const type: AgendaType = event.scope === "personal" ? "personal" : toAgendaType(event.kind);

  return {
    id: `event-${event.id}`,
    title: event.title,
    date: dateKey(start),
    start: event.allDay ? "00:00" : timeKey(start),
    end: event.allDay ? "23:59" : timeKey(end),
    location: event.location || "",
    type,
    visual: event.kind === "deadline" ? "ddl" : type,
    source: event.scope === "personal" ? undefined : KIND_LABEL[event.kind],
    note: event.note,
    link: event.link,
    allDay: event.allDay,
    rawKind: event.kind,
    deletable: event.scope === "personal" || ownerMatch,
    scope: event.scope,
    college: event.college,
    grade: event.grade,
    course: event.course,
  };
}

/**
 * ddls 表 → 视图事件。
 * DDL 只有「截止时刻」，没有起始时间，因此以截止时间为 end、往前 30 分钟作为 start，
 * 这样时钟弧带和课表都能画出可感知的长度，而不会退化成一个点。
 */
export function mapDdl(ddl: Ddl): AgendaEvent | null {
  const due = parseDate(ddl.dueAt);
  if (!due) return null;

  // 作业是一个「截止点」，不是一段任务：不提前 30 分钟、也不给假时长，
  // 否则日历上会出现一块根本没有发生过的 30 分钟。
  return {
    id: `ddl-${ddl.id}`,
    title: ddl.title,
    date: dateKey(due),
    start: timeKey(due),
    end: timeKey(due),
    location: "",
    type: "course",
    visual: "ddl",
    source: "作业截止",
    note: ddl.note,
    link: ddl.url,
    rawKind: "ddl",
    deletable: true,
    scope: "personal",
    course: ddl.course,
    done: ddl.status === "done",
  };
}

/** checkins 表 → 视图事件。签到是「已经发生」的事实，落在个人类别 */
export function mapCheckin(checkin: Checkin): AgendaEvent | null {
  const at = parseDate(checkin.occurredAt);
  if (!at) return null;

  return {
    id: `checkin-${checkin.id}`,
    title: `${checkin.course} 签到`,
    date: dateKey(at),
    start: timeKey(at),
    end: timeKey(addMinutes(at, 15)),
    location: "",
    type: "personal",
    visual: "personal",
    source: "签到",
    note: checkin.note,
    rawKind: "checkin",
    deletable: true,
    scope: "personal",
    course: checkin.course,
  };
}

/** 单条事件占用的分钟数，供时间轴与课表估算块高 */
export function durationMinutes(event: AgendaEvent): number {
  const [sh, sm] = event.start.split(":").map(Number);
  const [eh, em] = event.end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

export function agendaTimeLabel(event: AgendaEvent): string {
  if (event.allDay) return "全天";
  if (event.rawKind === "deadline") {
    // 原文没写钟点的截止，库里存的是 23:59（为了排序），别把它当成真实时间显示
    const hasClock = /截止：\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(event.note || "");
    return hasClock ? `${event.start} 截止` : "截止";
  }
  if (event.end <= event.start) return event.start;
  return `${event.start}–${event.end}`;
}

/** 课表会话 → 视图事件。课表是本机数据，归属 personal 但 visual 为 course */
export function mapTimetable(session: TimetableSession): AgendaEvent | null {
  const start = parseDate(session.startAt);
  if (!start) return null;
  const end = resolveEnd(start, parseDate(session.endAt), Boolean(session.allDay));
  return {
    id: `tt-${session.title}-${session.startAt}`,
    title: session.title,
    date: dateKey(start),
    start: session.allDay ? "00:00" : timeKey(start),
    end: session.allDay ? "23:59" : timeKey(end),
    location: session.location || session.course || "",
    type: "course",
    visual: "course",
    source: "课表",
    note: session.teacher ? `${session.teacher} 老师` : undefined,
    allDay: Boolean(session.allDay),
    rawKind: "other",
    deletable: false,
    scope: "personal",
    course: session.course,
  };
}

/** 本机个人事件（MyEvent）→ 视图事件 */
export function mapMyEvent(ev: MyEvent): AgendaEvent | null {
  const start = parseDate(ev.startAt);
  if (!start) return null;
  const isDeadline = ev.kind === "deadline";
  const end = isDeadline ? start : resolveEnd(start, parseDate(ev.endAt), ev.allDay);
  return {
    id: `my-${ev.id}`,
    title: ev.title,
    date: dateKey(start),
    start: ev.allDay ? "00:00" : timeKey(start),
    end: ev.allDay ? "23:59" : timeKey(end),
    location: ev.location || ev.course || "",
    type: "personal",
    visual: isDeadline ? "ddl" : "personal",
    source: "个人",
    note: ev.note,
    link: ev.link,
    allDay: ev.allDay,
    rawKind: isDeadline ? "deadline" : "other",
    deletable: true,
    scope: "personal",
    course: ev.course,
  };
}

/** 「我的」中导入的群聊事项已有独立存储，由该页管理。 */
function mapGroupItem(item: PersonalItem): AgendaEvent | null {
  const start = parseDate(item.startAt);
  if (!start) return null;
  const allDay = Boolean(item.allDay);
  return {
    id: `group-${JSON.stringify([item.kind, item.startAt, item.title])}`,
    title: item.title,
    date: dateKey(start),
    start: allDay ? "00:00" : timeKey(start),
    end: allDay ? "23:59" : timeKey(item.kind === "deadline" ? start : resolveEnd(start, parseDate(item.endAt), false)),
    location: item.location || item.course || "",
    type: "personal",
    visual: item.kind === "deadline" ? "ddl" : "personal",
    source: "群聊",
    note: item.note,
    allDay,
    rawKind: item.kind,
    deletable: false,
    scope: "personal",
    course: item.course,
  };
}

/** 合并公共事件表 + 本机三张表（ddls/checkins/myEvents）+ 课表，按开始时间排序 */
export function buildAgenda(
  events: CalEvent[],
  ddls: Ddl[],
  checkins: Checkin[],
  ctx: MapContext = {},
  myEvents: MyEvent[] = [],
  timetable: TimetableSession[] = [],
  groupItems: PersonalItem[] = []
): AgendaEvent[] {
  const merged = [
    ...events.map((item) => mapCalEvent(item, ctx)),
    ...ddls.map(mapDdl),
    ...checkins.map(mapCheckin),
    ...myEvents.map(mapMyEvent),
    ...timetable.map(mapTimetable),
    ...groupItems.map(mapGroupItem),
  ].filter((item): item is AgendaEvent => item !== null);

  return merged.sort(
    (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)
  );
}

/**
 * 悬停提示：这条为什么排在前面。
 * 分数只在有依据时才有意义，没算过就不显示，避免出现「相关度 undefined」。
 */
export function relevanceHint(event: AgendaEvent): string | undefined {
  if (!event.reasons?.length) return undefined;
  return `相关度 ${event.score ?? "-"}：${event.reasons.join("、")}`;
}
