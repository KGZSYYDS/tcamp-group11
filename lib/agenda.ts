import type { CalEvent, Checkin, Ddl, EventKind } from "./types";

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
}

const KIND_LABEL: Record<EventKind, string> = {
  exam: "考试",
  pe: "体测",
  activity: "活动",
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
  if (endAt && endAt.getTime() >= start.getTime()) return endAt;
  return allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59) : addMinutes(start, 60);
}

export interface MapContext {
  currentUserId?: string;
}

/** events 表 → 视图事件 */
export function mapCalEvent(event: CalEvent, ctx: MapContext = {}): AgendaEvent | null {
  const start = parseDate(event.startAt);
  if (!start) return null;
  const end = resolveEnd(start, parseDate(event.endAt), event.allDay);
  const ownerMatch = Boolean(ctx.currentUserId && event.ownerId === ctx.currentUserId);
  const type: AgendaType = event.scope === "personal" ? "personal" : toAgendaType(event.kind);

  return {
    id: `event-${event.id}`,
    title: event.title,
    date: dateKey(start),
    start: event.allDay ? "00:00" : timeKey(start),
    end: event.allDay ? "23:59" : timeKey(end),
    location: event.location || event.course || "",
    type,
    visual: type,
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

  // 截止在 00:00–00:29 时，往前推 30 分钟会落到前一天。
  // 此时日期应跟着开始时间走，否则会出现「日期 11-10、时间 23:30」这种自相矛盾的数据
  const start = addMinutes(due, -30);
  const crossesDay =
    start.getFullYear() !== due.getFullYear() ||
    start.getMonth() !== due.getMonth() ||
    start.getDate() !== due.getDate();
  const anchor = crossesDay ? start : due;

  return {
    id: `ddl-${ddl.id}`,
    title: ddl.title,
    date: dateKey(anchor),
    // 跨日时把区间截断到当天，避免 end 小于 start 让弧带与块高计算失效
    start: timeKey(start),
    end: crossesDay ? "23:59" : timeKey(due),
    location: ddl.course || "",
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
    location: checkin.teacher ? `${checkin.teacher} 老师` : "",
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

/** 合并三张表，并按开始时间排序 */
export function buildAgenda(
  events: CalEvent[],
  ddls: Ddl[],
  checkins: Checkin[],
  ctx: MapContext = {}
): AgendaEvent[] {
  const merged = [
    ...events.map((item) => mapCalEvent(item, ctx)),
    ...ddls.map(mapDdl),
    ...checkins.map(mapCheckin),
  ].filter((item): item is AgendaEvent => item !== null);

  return merged.sort(
    (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)
  );
}

/**
 * 一条事件归属的「筛选类别」集合。
 *
 * 之所以需要多类别归属，是因为筛选按钮和视觉配色用的是同一套 visual，
 * 但 visual 是互斥单值（一条事件只能有一个），而真实的分类意图是交叉的：
 *  - DDL 是「作业截止」，但它也属于某门「课程」
 *  - 课程签到记录在 checkins 表，visual=personal，但它也属于「课程」
 *  - 一场课程考试 kind=exam → visual=notice，但它也属于「课程」
 *
 * 如果用单值 visual 过滤，关掉「课程」按钮只会把 visual=course 的事件隐藏——
 * 但实际上从没有任何事件的 visual 等于 "course"，于是「课程」按钮形同虚设；
 * 更糟的是只开「课程」关掉其它三个时，所有课程相关的 DDL / 签到 / 课程考试
 * 都会被另外三个按钮挡掉，用户看到空白。
 *
 * 改成「任一所属类别启用即显示」后，关掉单一类别不会让跨类别事件消失，
 * 只有同时关掉它归属的全部类别才会隐藏——这才是「不遗漏」的语义。
 */
export function categoriesOf(event: AgendaEvent): AgendaVisual[] {
  const set = new Set<AgendaVisual>([event.visual]);
  // 带课程名的事件（课程考试、课程活动、课程签到等）也归入「课程」
  if (event.course) set.add("course");
  // DDL 是课程作业，签到是课程签到，二者本质上都属于「课程」
  if (event.visual === "ddl" || event.rawKind === "checkin") set.add("course");
  return Array.from(set);
}

/** 单条事件占用的分钟数，供时间轴与课表估算块高 */
export function durationMinutes(event: AgendaEvent): number {
  const [sh, sm] = event.start.split(":").map(Number);
  const [eh, em] = event.end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}
