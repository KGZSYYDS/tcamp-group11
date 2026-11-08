export type DdlStatus = "pending" | "done";

export interface Ddl {
  id: string;
  course: string;
  title: string;
  /** ISO 8601 截止时间，建议带时区，如 2026-11-08T23:59:00+08:00 */
  dueAt: string;
  url?: string;
  note?: string;
  status: DdlStatus;
  /** manual=手动录入 import=批量导入，后续可扩展为具体采集器名 */
  source: string;
  createdAt: string;
}

/** 新增 / 导入时使用的载荷 */
export interface DdlInput {
  course: string;
  title: string;
  dueAt: string;
  url?: string;
  note?: string;
  source?: string;
}

/** 签到事件：手动记录或采集器上报 */
export interface Checkin {
  id: string;
  course: string;
  /** 授课老师，可空；统计时按 课程+老师 聚合 */
  teacher?: string;
  /** 签到发生时间 ISO 8601 */
  occurredAt: string;
  note?: string;
  /** manual=手动记录 import=批量导入，后续采集器可标记来源 */
  source: string;
  createdAt: string;
}

export interface CheckinInput {
  course: string;
  teacher?: string;
  occurredAt: string;
  note?: string;
  source?: string;
}

/** 通用日历事件：考试 / 体测 / 活动 / 其他 */
export type EventKind = "exam" | "pe" | "activity" | "other";

export interface CalEvent {
  id: string;
  kind: EventKind;
  title: string;
  /** 发生时间 ISO 8601；allDay 时只取日期部分 */
  startAt: string;
  /** 结束时间（时间段事件，如体测周）；空表示单日事件 */
  endAt?: string;
  /** 预约 / 详情入口链接 */
  link?: string;
  allDay: boolean;
  course?: string;
  location?: string;
  note?: string;
  /** school=全校 college=学院 grade=年级 personal=仅自己 */
  scope: string;
  college?: string;
  grade?: string;
  /** 创建者，仅用于 UI 判断是否显示删除按钮，不作安全边界 */
  ownerId?: string;
  source: string;
  createdAt: string;
}

export interface CalEventInput {
  kind: EventKind;
  title: string;
  startAt: string;
  endAt?: string;
  link?: string;
  allDay?: boolean;
  course?: string;
  location?: string;
  note?: string;
  scope?: string;
  college?: string;
  grade?: string;
  source?: string;
  /** 来源通知链接，用于公共事件去重 */
  sourceUrl?: string;
}

/** 个人画像：用于公共事件的相关性过滤 */
export interface Profile {
  college?: string;
  major?: string;
  grade?: string;
  /** 培养层次：undergraduate 本科 / postgraduate 硕士 / doctoral 博士 */
  level?: string;
  courses: string[];
}



