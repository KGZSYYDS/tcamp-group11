"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalEvent, Checkin, Ddl, EventKind, Profile } from "@/lib/types";
import {
  createEvent,
  deleteEvent,
  getProfile,
  listEvents,
} from "@/lib/data";
import {
  addMyEvent,
  loadCheckins,
  loadDdls,
  loadMyEvents,
  loadTimetable,
  removeCheckin,
  removeDdl,
  removeMyEvent,
} from "@/lib/local-store";
import type { LocalTimetable } from "@/lib/local-store";
import { buildAgenda, dateKey } from "@/lib/agenda";
import type { AgendaEvent } from "@/lib/agenda";

export type AgendaSource = "events" | "ddls" | "checkins" | "my" | "timetable";

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

/** 判断某条视图事件来自哪个数据源，删除时据此分发 */
function sourceOf(event: AgendaEvent): AgendaSource {
  if (event.rawKind === "ddl") return "ddls";
  if (event.rawKind === "checkin") return "checkins";
  if (event.id.startsWith("my-")) return "my";
  if (event.id.startsWith("tt-")) return "timetable";
  return "events";
}

/** 视图 id 前缀是 `event-` / `ddl-` / `checkin-` / `my-` / `tt-`，剥掉后得到主键 */
function rawId(event: AgendaEvent): string {
  return event.id.replace(/^(event|ddl|checkin|my|tt-[^-]+-)/, "");
}

/**
 * 数据来源：云库 public events（listEvents） + 本机 ddls / checkins / myEvents / timetable。
 * 云库只取公共事件，personal 行在服务端已被过滤；个人数据全部留在浏览器本地。
 */
export function useAgenda(currentUserId: string): AgendaState {
  const [rawEvents, setRawEvents] = useState<CalEvent[]>([]);
  const [rawDdls, setRawDdls] = useState<Ddl[]>([]);
  const [rawCheckins, setRawCheckins] = useState<Checkin[]>([]);
  const [rawMy, setRawMy] = useState<ReturnType<typeof loadMyEvents>>([]);
  const [rawTt, setRawTt] = useState<LocalTimetable["events"]>([]);
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
      // 云库只取公共事件 + profile；个人数据从本机同步读取
      const [events, prof] = await Promise.all([
        listEvents(),
        getProfile().catch(() => null),
      ]);
      if (!mounted.current) return;
      setRawEvents(events);
      setProfile(prof);
      // 本机数据（localStorage）是同步 API
      setRawDdls(loadDdls());
      setRawCheckins(loadCheckins());
      setRawMy(loadMyEvents());
      const tt = loadTimetable();
      setRawTt(tt ? tt.events : []);
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

  // 监听本机存储变化（其它 Tab 写入 / 导入），同步刷新
  useEffect(() => {
    const onStorage = () => {
      setRawDdls(loadDdls());
      setRawCheckins(loadCheckins());
      setRawMy(loadMyEvents());
      const tt = loadTimetable();
      setRawTt(tt ? tt.events : []);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const events = useMemo(
    () => buildAgenda(rawEvents, rawDdls, rawCheckins, { currentUserId }, rawMy, rawTt),
    [rawEvents, rawDdls, rawCheckins, rawMy, rawTt, currentUserId]
  );

  /**
   * 新建日程：
   * - scope=personal → 本机 MyEvent
   * - 其它 scope（school/college/grade/...）→ 云库 events 表
   */
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
      if (Number.isNaN(endDate.getTime()) || endDate <= startDate) {
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      }

      if ((input.scope || "personal") === "personal") {
        addMyEvent({
          kind: input.kind,
          title: input.title,
          startAt: startDate.toISOString(),
          endAt: endDate.toISOString(),
          allDay: Boolean(input.allDay),
          link: input.link,
          course: input.course,
          location: input.location,
          note: input.note,
        });
        // 本机数据，同步刷新
        setRawMy(loadMyEvents());
        return;
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

  /** 删除：按数据源分发，不会误删其它表 */
  const removeAgendaEvent = useCallback<AgendaState["removeAgendaEvent"]>(
    async (event) => {
      const source = sourceOf(event);
      if (source === "ddls") {
        removeDdl(rawId(event));
        setRawDdls(loadDdls());
      } else if (source === "checkins") {
        removeCheckin(rawId(event));
        setRawCheckins(loadCheckins());
      } else if (source === "my") {
        removeMyEvent(rawId(event));
        setRawMy(loadMyEvents());
      } else {
        await deleteEvent(rawId(event));
        setRawEvents((prev) => prev.filter((e) => e.id !== rawId(event)));
      }
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
      if (!profile?.college) return true;
      return item.college === profile.college;
    }
    if (item.scope === "grade") {
      if (!profile?.grade) return true;
      return item.grade === profile.grade;
    }
    if (item.scope === "undergraduate" || item.scope === "postgraduate" || item.scope === "doctoral") {
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