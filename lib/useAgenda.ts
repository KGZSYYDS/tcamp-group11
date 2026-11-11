"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalEvent, Checkin, Ddl, EventKind, Profile } from "@/lib/types";
import {
  createEvent,
  deleteEvent,
  getProfile,
  listEvents,
  subscribeEvents,
} from "@/lib/data";
import { IS_PUBLIC_DEPLOY } from "@/lib/runtime-mode";
import {
  addMyEvent,
  loadCheckins,
  loadDdls,
  loadMyEvents,
  loadPersonal,
  loadTimetable,
  removeCheckin,
  removeDdl,
  removeMyEvent,
} from "@/lib/local-store";
import type { LocalTimetable } from "@/lib/local-store";
import type { SzUser } from "@/lib/szu-types";
import { sameAffiliation } from "@/lib/visibility";
import { scoreEvent } from "@/lib/relevance.mjs";
import { categoryOf, collegeNamesIn, isSchoolWide } from "@/lib/categorize.mjs";
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
export function useAgenda(session: SzUser | null): AgendaState {
  const currentUserId = session?.studentId || "";
  const [rawEvents, setRawEvents] = useState<CalEvent[]>([]);
  const [rawDdls, setRawDdls] = useState<Ddl[]>([]);
  const [rawCheckins, setRawCheckins] = useState<Checkin[]>([]);
  const [rawMy, setRawMy] = useState<ReturnType<typeof loadMyEvents>>([]);
  const [timetable, setTimetable] = useState<LocalTimetable | null>(null);
  const [groupItems, setGroupItems] = useState<NonNullable<ReturnType<typeof loadPersonal>>["events"]>([]);
  const [cloudProfile, setCloudProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshLocal = useCallback(() => {
    setRawDdls(loadDdls());
    setRawCheckins(loadCheckins());
    setRawMy(loadMyEvents());
    setTimetable(loadTimetable());
    setGroupItems(loadPersonal()?.events || []);
  }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    const isCurrent = () => mounted.current && requestId.current === id;
    refreshLocal();
    setError("");
    setLoaded(false);
    try {
      const events = await listEvents();
      if (!isCurrent()) return;
      setRawEvents(events);
    } catch {
      if (!isCurrent()) return;
      setError("校园通知暂时无法加载，仍可查看本机日程。");
    } finally {
      if (isCurrent()) setLoaded(true);
    }
  }, [refreshLocal]);

  useEffect(() => {
    const unsubscribe = subscribeEvents(setRawEvents);
    void refresh();
    void getProfile().then((p) => {
      if (mounted.current) setCloudProfile(p);
    }).catch(() => {});
    return unsubscribe;
  }, [refresh]);

  // 监听本机存储变化（其它 Tab 写入 / 导入），同步刷新
  useEffect(() => {
    window.addEventListener("storage", refreshLocal);
    return () => window.removeEventListener("storage", refreshLocal);
  }, [refreshLocal]);

  const profile = useMemo<Profile>(() => {
    const local = timetable?.profile;
    const ownLocal = !session || !local?.studentId || local.studentId === session.studentId ? local : undefined;
    return {
      college: cloudProfile?.college || session?.college || ownLocal?.college,
      major: cloudProfile?.major || session?.major || ownLocal?.major,
      grade: cloudProfile?.grade || session?.grade || ownLocal?.grade,
      level: cloudProfile?.level || session?.level || ownLocal?.level,
      courses: ownLocal && timetable?.courses.length ? timetable.courses : cloudProfile?.courses || [],
    };
  }, [session, timetable, cloudProfile]);

  const events = useMemo(
    () => buildAgenda(rawEvents, rawDdls, rawCheckins, { currentUserId }, rawMy, timetable?.events, groupItems),
    [rawEvents, rawDdls, rawCheckins, rawMy, timetable, groupItems, currentUserId]
  );

  /**
   * 新建日程：
   * - scope=personal → 本机 MyEvent
   * - 其它 scope（school/college/grade/...）→ 云库 events 表
   *
   * 公网模式下「其它 scope」一律按本机处理：events 是一张所有访客共用、且只能靠
   * 可发布 key 写入的表，开放界面直写等于让任何人都能往全校日历里塞条目。
   * 公网版本定位是「看公共通知 + 存自己的日程」，本来也不需要跨用户发布。
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

      if (IS_PUBLIC_DEPLOY || (input.scope || "personal") === "personal") {
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
 * 现在是学年的第几年。
 *
 * 年级字段的写法不统一：可能是「大一」「2026」「2026级」。
 * 学年的分界放在 9 月：8 月还属于上一学年，9 月才算新学年开始。
 * 解析不出来返回 null —— 调用方据此保守处理（当作「不确定」）。
 */
export function gradeYear(grade: string | undefined, now = new Date()): number | null {
  const g = String(grade ?? "").normalize("NFKC").replace(/\s+/g, "");
  if (!g) return null;

  const cn = /^大([一二三四五])$/.exec(g)?.[1];
  if (cn) return "一二三四五".indexOf(cn);

  const digits = /^(?:20)?(\d{2})(?:级)?$/.exec(g);
  if (!digits) return null;
  const enrollment = 2000 + Number(digits[1]);
  const month = now.getMonth() + 1;
  // 9 月之后算新学年：2026 年 9 月入学的人在 2026-09 是第 1 年
  const academic = month < 9 ? now.getFullYear() - 1 : now.getFullYear();
  const year = academic - enrollment + 1;
  return year >= 1 && year <= 8 ? year : null;
}

/** 大一的判断只用于「领航讲座」默认开不开：那是学分要求，大二之后基本刷够了 */
export function isFreshman(profile: Profile | null): boolean {
  if (!profile) return false;
  // 研究生不涉及本科的领航讲座学分
  if (profile.level && profile.level !== "undergraduate") return false;
  return gradeYear(profile.grade) === 1;
}

/** 计算画像匹配结果和同一天内的排序分数。 */
export function scoreAgenda(
  events: AgendaEvent[],
  profile: Profile | null,
  hiddenIds: string[]
): AgendaEvent[] {
  const viewer = {
    college: profile?.college,
    major: profile?.major,
    grade: profile?.grade,
    level: profile?.level,
    courses: profile?.courses || [],
  };

  const scored = events.map((item) => {
    // 分类只看来源与标题：课表→课程；本机待办/签到→作业；
    // 公共通知按标题里有没有学院名判校园 / 个人 / 别的学院
    const colleges = collegeNamesIn(item.title);
    const viewerCollege = profile?.college || "";
    // 三态：true=是本学院，false=确认是别学院，undefined=没设画像、判断不了
    const titleCollegeMatched: boolean | undefined =
      viewerCollege && colleges.length
        ? colleges.some((college) => sameAffiliation(college, viewerCollege))
        : undefined;
    const schoolWideTitle = isSchoolWide(item.title);
    const category = categoryOf({
      source: item.source,
      rawKind: item.rawKind,
      scope: item.scope,
      hasCollege: colleges.length > 0,
      schoolWide: schoolWideTitle,
      isMine: titleCollegeMatched,
    });

    if (!item.scope || item.scope === "personal" || item.movedFromCampus) {
      return { ...item, category, score: 100, related: true, reasons: ["仅自己"] };
    }
    const result = scoreEvent(
      {
        kind: item.rawKind,
        title: item.title,
        note: item.note,
        scope: item.scope,
        college: item.college,
        boardSubtype: item.boardSubtype,
        at: new Date(`${item.date}T${item.start || "00:00"}:00`),
        allDay: item.allDay,
        location: item.location,
        titleCollegeMatched,
        schoolWideTitle,
        collegeMatched:
          item.scope === "college" && item.college && profile?.college
            ? sameAffiliation(item.college, profile.college)
            : undefined,
      },
      viewer
    );
    return { ...item, category, ...result };
  });

  return scored.filter((item) => !hiddenIds.includes(item.id));
}

export function isRelatedEvent(event: AgendaEvent): boolean {
  return event.related !== false;
}

/** 视图层按日期分组，供月历 / 课表 / 时间轴直接取用 */
export function groupByDate(events: AgendaEvent[]): Map<string, AgendaEvent[]> {
  const map = new Map<string, AgendaEvent[]>();
  for (const item of events) {
    const list = map.get(item.date);
    if (list) list.push(item);
    else map.set(item.date, [item]);
  }
  // 同一天内先看得分高的，同分按时间。月历、时间轴都直接消费这个顺序，
  // 「先看更相关的」比「先看更早的」更贴近校园通知的阅读习惯。
  for (const list of map.values()) {
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.start.localeCompare(b.start));
  }
  return map;
}

export { dateKey };
