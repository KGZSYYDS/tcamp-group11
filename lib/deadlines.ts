/**
 * 统一的「截止日期」视图。
 *
 * DDL 就是截止日期，不是某一类专属数据。它有四个来源，都该出现在同一个列表里：
 *
 *   manual / lms-sync  → **本机 localStorage 的 ddls**（手动添加、畅课插件同步）
 *   board / web        → 云端 events 里 kind=deadline 的公共截止（公文通、官网）
 *   wechat             → 本机 personal 里的群聊截止（班级群、社团群通知）
 *   timetable          → 课表本身不带截止，这里不用
 *
 * 只有本机 ddls 里的能手改、能删；公共的（board）标「公共」，
 * 「完成」的勾选对所有非本机来源只存 localStorage，因为公共截止不属于你个人。
 */
import type { CalEvent, Ddl } from "./types";
import { loadPersonal } from "./local-store";

export type DeadlineSource = "manual" | "lms-sync" | "board" | "web" | "wechat" | "paste-import";

export interface UnifiedDeadline {
  /** 稳定键：ddls 用 id，事件用 `<source>:<id>`，群聊用 `wechat:<date>|<title>` */
  key: string;
  /** 左侧小标签：课程名 / 栏目 / 群名 */
  tag: string;
  title: string;
  dueAt: string;
  url?: string;
  note?: string;
  status: "pending" | "done";
  source: DeadlineSource;
  /** 能否改 / 删 / 同步状态回云端 */
  editable: boolean;
  /** 已完成是不是本机记的（公共截止没有云端状态） */
  localDone?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动",
  "lms-sync": "畅课",
  board: "公文通",
  web: "官网",
  wechat: "群聊",
  "paste-import": "粘贴",
};

export function sourceLabel(s: string) {
  return SOURCE_LABEL[s] || s;
}

/** 从公文通备注里抠出栏目名（采集器写的是「栏目：教务｜…」） */
function categoryOf(note?: string) {
  const m = String(note || "").match(/栏目：([^｜|]+)/);
  return m ? m[1].trim() : "";
}

export function buildDeadlines(
  ddls: Ddl[],
  events: CalEvent[],
  doneKeys: string[] = []
): UnifiedDeadline[] {
  const done = new Set(doneKeys);

  const fromTable: UnifiedDeadline[] = ddls.map((d) => ({
    key: `ddl:${d.id}`,
    tag: d.course,
    title: d.title,
    dueAt: d.dueAt,
    url: d.url,
    note: d.note,
    status: d.status,
    source: (d.source === "lms-sync"
      ? "lms-sync"
      : d.source === "paste-import"
        ? "paste-import"
        : "manual") as DeadlineSource,
    editable: true,
  }));

  const fromBoard: UnifiedDeadline[] = events
    .filter((e) => e.kind === "deadline")
    .map((e) => {
      /**
       * 公共截止的稳定键：标题 + 日期 + 学院。
       *
       * 以前用的是 `event:<自增 id>`，但 ingest 是「删了再插」，重新入库就换 id，
       * 用户勾过的「已完成」全部对不上，第二天又变回待办。
       * 这三个字段对同一条通知是稳定的，换了 id 也能命中。
       */
      const key = `event:${e.title}|${String(e.startAt).slice(0, 10)}|${e.college || ""}`;
      return {
        key,
        tag: categoryOf(e.note) || "全校",
        title: e.title,
        dueAt: e.startAt,
        url: e.link,
        note: e.note,
        status: done.has(key) ? ("done" as const) : ("pending" as const),
        source: (e.source === "wechat" ? "wechat" : e.source === "web" ? "web" : "board") as DeadlineSource,
        editable: e.source === "manual",
        localDone: true,
      };
    });

  const fromLocal: UnifiedDeadline[] = (loadPersonal()?.events || [])
    .filter((e) => e.kind === "deadline")
    .map((e) => {
      const key = `wechat:${e.startAt.slice(0, 10)}|${e.title}`;
      // 群名的分隔符有两种：网页抽取用「｜」，命令行采集器用「 · 」。
      // 只按「·」切会把「群名｜原话：…」整段当成群名塞进标签，所以两种都要认。
      const group = String(e.note || "").match(/来自群：([^·｜|]+)/);
      return {
        key,
        tag: group ? group[1].trim().slice(0, 12) : "群聊",
        title: e.title,
        dueAt: e.startAt,
        note: e.note,
        status: done.has(key) ? ("done" as const) : ("pending" as const),
        source: "wechat" as DeadlineSource,
        editable: false,
        localDone: true,
      };
    });

  // 同一天同一标题在多处出现时只留一条：公文通那条 URL 更权威，优先保留
  const byKey = new Map<string, UnifiedDeadline>();
  for (const d of [...fromTable, ...fromBoard, ...fromLocal]) {
    const dedupe = `${d.dueAt.slice(0, 10)}|${d.title.replace(/\s+/g, "")}`;
    const prev = byKey.get(dedupe);
    // 官网条目常常只是转载，权威性最低；同一条只让公文通/手动活下来
    if (!prev || (prev.source === "wechat" && d.source === "board") || (prev.source === "web" && d.source !== "web")) {
      byKey.set(dedupe, d);
    }
  }

  return [...byKey.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}
