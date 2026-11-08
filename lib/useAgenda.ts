"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalEvent, Checkin, Ddl, EventKind, Profile } from "@/lib/types";
import {
  createEvent,
  deleteCheckin,
  deleteDdl,
  deleteEvent,
  getProfile,
  listCheckins,
  listDdls,
  listEvents,
} from "@/lib/data";
import { buildAgenda, dateKey } from "@/lib/agenda";
import type { AgendaEvent } from "@/lib/agenda";

export type AgendaSource = "events" | "ddls" | "checkins";

export interface AgendaState {
  events: AgendaEvent[];
  profile: Profile | null;
  loaded: boolean;
  error: string;
  refresh: () => Promise<void>;
  createAgendaEvent: (input: {
    kind: EventKind;
    title: string;
    date: string;
    start: string;
    end: string;
    location?: string;
    note?: string;
    link?: string;
    allDay?: boolean;
    scope?: string;
    college?: string;
    grade?: string;
    course?: string;
  }) => Promise<void>;
  removeAgendaEvent: (event: AgendaEvent) => Promise<void>;
}

/** 判断某条视图事件来自哪张后端表，删除时据此分发 */
function sourceOf(event: AgendaEvent): AgendaSource {
  if (event.rawKind === "ddl") return "ddls";
  if (event.rawKind === "checkin") return "checkins";
  return "events";
}

/** 视图 id 前缀是 `event-` / `ddl-` / `checkin-`，剥掉后得到数据库主键 */
function rawId(event: AgendaEvent): string {
  return event.id.replace(/^(event|ddl|checkin)-/, "");
}

/**
 * 把后端「三张表」聚合成原型四视图需要的一份日程流。
 * 所有读写都仍然走 lib/data.ts 的既有函数，因此云同步、RLS、插件导入逻辑不受影响。
 */
export function useAgenda(currentUserId: string): AgendaState {
  const [rawEvents, setRawEvents] = useState<CalEvent[]>([]);
  const [rawDdls, setRawDdls] = useState<Ddl[]>([]);
  const [rawCheckins, setRawCheckins] = useState<Checkin[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [events, ddls, checkins, prof] = await Promise.all([
        listEvents(),
        listDdls(),
        listCheckins(),
        getProfile().catch(() => null),
      ]);
      if (!mounted.current) return;
      setRawEvents(events);
      setRawDdls(ddls);
      setRawCheckins(checkins);
      setProfile(prof);
      setError("");
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "数据加载失败");
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const events = useMemo(
    () => buildAgenda(rawEvents, rawDdls, rawCheckins, { currentUserId }),
    [rawEvents, rawDdls, rawCheckins, currentUserId]
  );

  /** 新建日程：统一落 events 表，与「粘贴导入」「插件同步」写入同一张表 */
  const createAgendaEvent = useCallback<AgendaState["createAgendaEvent"]>(
    async (input) => {
      const [sh, sm] = input.start.split(":").map(Number);
      const startDate = new Date(
        `${input.date}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00`
      );
      if (Number.isNaN(startDate.getTime())) throw new Error("开始时间格式无效");

      const [eh, em] = input.end.split(":").map(Number);
      let endDate = new Date(
        `${input.date}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00`
      );
      // 结束早于开始视为跨日，顺延到第二天
      if (Number.isNaN(endDate.getTime()) || endDate <= startDate) {
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      }

      await createEvent({
        kind: input.kind,
        title: input.title,
        startAt: startDate.toISOString(),
        endAt: endDate.toISOString(),
        allDay: input.allDay,
        course: input.course,
        location: input.location,
        note: input.note,
        link: input.link,
        scope: input.scope || "personal",
        college: input.college,
        grade: input.grade,
      });
      await refresh();
    },
    [refresh]
  );

  /** 删除：按来源表分发，DDL / 签到走各自接口，不会误删到 events */
  const removeAgendaEvent = useCallback<AgendaState["removeAgendaEvent"]>(
    async (event) => {
      const id = rawId(event);
      const source = sourceOf(event);
      if (source === "ddls") await deleteDdl(id);
      else if (source === "checkins") await deleteCheckin(id);
      else await deleteEvent(id);

      if (source === "ddls") setRawDdls((prev) => prev.filter((d) => d.id !== id));
      else if (source === "checkins") setRawCheckins((prev) => prev.filter((c) => c.id !== id));
      else setRawEvents((prev) => prev.filter((e) => e.id !== id));
    },
    []
  );

  return {
    events,
    profile,
    loaded,
    error,
    refresh,
    createAgendaEvent,
    removeAgendaEvent,
  };
}

/**
 * 相关性过滤：个人数据与全校事件始终显示；
 * 学院 / 年级 / 培养层次类公共事件按画像匹配，与旧版 CalendarPanel 规则保持一致。
 *
 * 「不遗漏」原则：当 onlyRelated 开启但画像（profile）缺少判断所需的字段时，
 * 无法确定相关性的公共事件默认显示，而不是静默丢弃。只有画像有对应字段
 * 且明确不匹配时才过滤。这样用户没填学院/年级时不会莫名看不到学院通知。
 */
export function filterByProfile(
  events: AgendaEvent[],
  profile: Profile | null,
  onlyRelated: boolean,
  hiddenIds: string[]
): AgendaEvent[] {
  return events.filter((item) => {
    if (hiddenIds.includes(item.id)) return false;
    if (!item.scope || item.scope === "personal" || item.scope === "school") return true;
    if (!onlyRelated) return true;
    if (item.scope === "college") {
      // 画像没填学院 → 无法判断，默认显示；填了但不匹配才过滤
      if (!profile?.college) return true;
      return item.college === profile.college;
    }
    if (item.scope === "grade") {
      if (!profile?.grade) return true;
      return item.grade === profile.grade;
    }
    if (item.scope === "undergraduate" || item.scope === "postgraduate" || item.scope === "doctoral") {
      // 画像没填培养层次 → 无法判断，默认显示
      if (!profile?.level) return true;
      return item.scope === profile.level;
    }
    return true;
  });
}

/** 视图层按日期分组，供月历 / 课表 / 时间轴直接取用 */
export function groupByDate(events: AgendaEvent[]): Map<string, AgendaEvent[]> {
  const map = new Map<string, AgendaEvent[]>();
  for (const item of events) {
    const list = map.get(item.date);
    if (list) list.push(item);
    else map.set(item.date, [item]);
  }
  return map;
}

export { dateKey };
