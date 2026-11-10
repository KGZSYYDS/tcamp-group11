import type { Audience, EventKind, Visibility } from "../types";

/**
 * 抽取产物：结构化事件的"草稿"。
 * 还不是数据库记录——没有 id、没有入库，置信度不够时只会进人工确认队列。
 */
export interface EventDraft {
  title: string;
  kind: EventKind;
  /** 事情发生时间；null 表示原文没给出可核实的日期 */
  occurAt: string | null;
  endAt: string | null;
  allDay: boolean;
  /** 行动截止（报名/提交/缴费），与 occurAt 是两个不同的时间 */
  actionDeadline: string | null;
  location: string | null;
  link: string | null;
  audience: Audience;
  visibility: Visibility;
  sourceUrl: string;
  collector: string;
  department?: string;
  confidence: number;
  /** 关键字段在原文中的依据，UI 可据此回原文定位 */
  evidence: string[];
  /** 原文含"另行通知/待定"等不确定表述 */
  uncertain: boolean;
  conflicts: string[];
}

export type IngestStatus = "ready" | "pending_review";

export function isDraftUsable(draft: EventDraft): boolean {
  return Boolean(draft.occurAt) && draft.confidence >= 0.6;
}
