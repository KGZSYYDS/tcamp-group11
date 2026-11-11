import { cloud } from "./cloud";
import { loadProfile, saveLocalProfile } from "./local-store";
import { IS_PUBLIC_DEPLOY } from "./runtime-mode";
import type { CalEvent, CalEventInput, Profile } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function unwrap<T>({ data, error }: { data: T; error: any }): T {
  if (error) throw new Error(error.message || "云端请求失败");
  return data;
}

/** 写入后受影响行数为 0 通常是未登录或越权（RLS 拦截），必须显式报错 */
function assertAffected(data: any[] | null) {
  if (!data || data.length === 0) {
    throw new Error("操作未生效：记录不存在或你没有权限");
  }
}

// ---------- 说明：ddls / checkins 已搬离云库 ----------
//
// 作业截止与签到记录属于「我的」这一层（见 lib/local-store.ts），
// 不再有云端读写函数。云库只保留公共事件（events）与个人画像（profiles）。

// ---------- 日历事件 ----------

/**
 * 公共事件的进程内缓存。
 *
 * 日历、提醒条、截止日期面板过去各自 `listEvents()`，页面上有 2–3 份全量数据，
 * 且提醒条每 60 秒再拉一遍 636 行。这里做一层共享缓存 + 失效通知：
 * 同一时刻只有一个请求在飞，其余调用方等它；写完（新建/删除）主动失效。
 *
 * TTL 取 5 分钟：通知不是秒级数据，没必要每分钟全量重拉。
 * 需要最新数据时传 `force`（面板刷新按钮走这条路）。
 *
 * **过期后不阻塞**：全表 404 行实测 1.6–3.1 秒（281KB，不走 order 更快）。
 * 如果 TTL 一到就让第一个访客同步等这三秒，每 5 分钟就有一个人看到「加载中…」
 * —— 同事说的「等一会就行」就是这个。所以过期时先把手上的旧数据交出去、
 * 后台悄悄换新（stale-while-revalidate），把这几秒从用户身上摘掉。
 */
const EVENTS_TTL = 5 * 60_000;

let eventsCache: CalEvent[] | null = null;
let eventsCachedAt = 0;
let eventsInflight: Promise<CalEvent[]> | null = null;
const eventsListeners = new Set<(rows: CalEvent[]) => void>();

/** 订阅公共事件更新；返回取消订阅函数 */
export function subscribeEvents(fn: (rows: CalEvent[]) => void): () => void {
  eventsListeners.add(fn);
  return () => {
    eventsListeners.delete(fn);
  };
}

/** 让缓存失效，下次读取会重新请求 */
export function invalidateEvents() {
  eventsCache = null;
  eventsCachedAt = 0;
}

function publishEvents(rows: CalEvent[]) {
  eventsCache = rows;
  eventsCachedAt = Date.now();
  for (const fn of eventsListeners) {
    try {
      fn(rows);
    } catch {
      /* 单个订阅方报错不影响其它人 */
    }
  }
}

/**
 * 后台换新：不 await、不抛给调用方。
 *
 * 失败时也要把计时推后，否则每个请求都会再撞一次云库（拉一次两三秒，
 * 等于把一次冷启动变成连续冷启动）。推后 5 分钟后自然重试。
 */
function refreshInBackground() {
  if (eventsInflight) return;
  eventsInflight = fetchEvents()
    .then((rows) => {
      publishEvents(rows);
      return rows;
    })
    .catch(() => {
      eventsCachedAt = Date.now();
      return eventsCache ?? [];
    })
    .finally(() => {
      eventsInflight = null;
    });
}


/**
 * 浏览器侧走本服务的 /api/events。
 *
 * 直连云库的代价是「每个访客一次全表拉取」——404 行、约 0.85 秒，十个人同时打开
 * 就是十次。服务端那份 5 分钟缓存只有在请求真的进到服务端时才起作用，所以浏览器
 * 必须改打自己家的接口。
 *
 * 返回 null 表示这一层不可用（本地直接起静态服务器、接口 404 等），调用方退回直连。
 */
async function fetchEventsViaApi(): Promise<CalEvent[] | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8_000);
  try {
    const res = await fetch("/api/events", {
      signal: timeout.signal,
      // 让浏览器也跟着缓存一分钟，切页面回来不必再问一次
      cache: "default",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: CalEvent[]; error?: string };
    /**
     * 接口在云库不可用时会回 200 + `events: []` + `error`，这是刻意的（避免 500 让
     * 调用方多走一次错误分支）。但**不能把这种空数组当成「真的没有通知」**：
     * 那样就永远不会退回下面直连云库的那条路，用户看到的是「一条都没有」且没有任何
     * 错误提示 —— 分不清是网络坏了还是学校没发通知。带 error 就当作这一层失败。
     */
    if (body.error) return null;
    return Array.isArray(body.events) ? body.events : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEvents(): Promise<CalEvent[]> {
  /**
   * 只有在浏览器里才走 /api/events。
   * 服务端（也就是 /api/events 自己）必须直连云库，否则会自己调自己。
   */
  if (typeof window !== "undefined") {
    const viaApi = await fetchEventsViaApi();
    if (viaApi) return viaApi;
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 12_000);
  try {
    const rows = unwrap(
      await cloud.database
        .from("events")
        .select("*")
        .neq("scope", "personal")
        .order("start_at", { ascending: true })
        .abortSignal(timeout.signal)
    ) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      title: r.title,
      startAt: r.start_at,
      endAt: r.end_at ?? undefined,
      link: r.link ?? undefined,
      allDay: r.all_day,
      course: r.course ?? undefined,
      location: r.location ?? undefined,
      note: r.note ?? undefined,
      scope: r.scope,
      college: r.college ?? undefined,
      grade: r.grade ?? undefined,
      ownerId: r.owner_id ?? undefined,
      source: r.source,
      sourceUrl: r.source_url ?? undefined,
      createdAt: r.created_at,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只取公共事件。personal 行一律在服务端过滤掉，不下发到浏览器——
 * 个人数据本来就不该进这张表，这里是不让历史脏数据继续外泄的第二道闸。
 *
 * 多次调用共享同一份缓存与同一个在途请求，见上面的 EVENTS_TTL。
 *
 * 三档行为：
 *   新鲜（< TTL）→ 直接返回，0ms
 *   过期但手上还有旧数据 → **立刻返回旧数据**，后台换新（`force` 除外）
 *   完全没有数据（进程刚起）→ 只能等，这是唯一必须阻塞的情况
 */
export async function listEvents(options?: { force?: boolean }): Promise<CalEvent[]> {
  const force = Boolean(options?.force);
  if (!force && eventsCache && Date.now() - eventsCachedAt < EVENTS_TTL) {
    return eventsCache;
  }
  if (eventsInflight) return eventsInflight;

  // 过期但有旧数据：先给旧数据，别让访客为这次刷新等两三秒。
  // force 是「刷新」按钮，用户明确要最新的，那就该等。
  if (!force && eventsCache) {
    refreshInBackground();
    return eventsCache;
  }

  eventsInflight = fetchEvents()
    .then((rows) => {
      publishEvents(rows);
      return rows;
    })
    .finally(() => {
      eventsInflight = null;
    });

  return eventsInflight;
}

export async function createEvent(input: CalEventInput) {
  const { data, error } = await cloud.database
    .from("events")
    .insert({
      kind: input.kind,
      title: input.title.trim(),
      start_at: new Date(input.startAt).toISOString(),
      end_at: input.endAt ? new Date(input.endAt).toISOString() : null,
      link: input.link?.trim() || null,
      all_day: Boolean(input.allDay),
      course: input.course?.trim() || null,
      location: input.location?.trim() || null,
      note: input.note?.trim() || null,
      scope: input.scope || "personal",
      college: input.college?.trim() || null,
      grade: input.grade?.trim() || null,
      source: input.source || "manual",
      source_url: input.sourceUrl || null,
    } as any)
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
  // 新建成功后立刻让缓存失效，下一次读会拿到包含新行的列表
  invalidateEvents();
}

export async function deleteEvent(id: string) {
  const { data, error } = await cloud.database
    .from("events")
    .delete()
    .eq("id", Number(id))
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
  invalidateEvents();
}

/**
 * 课表不再走云端认领。
 *
 * 原先的做法是：采集器以 anon 身份把课表写进公开的 events 表，再用学号哈希
 * 把行标记归属，用户填学号「认领」。这个设计有个绕不开的问题——学号是可枚举的
 * 数字串，谁先认领算谁的，而且哈希本身挡不住反推。
 *
 * 现在课表和群聊待办都只存在浏览器本地（lib/local-store.ts），云端只放公共数据，
 * 归属由「谁的浏览器就是谁的」天然保证，不需要任何归属字段。
 */

/** 公共事件按来源链接查重：同一通知任何人采集过就不再重复入库 */
export async function eventExistsBySourceUrl(url: string): Promise<boolean> {
  if (!url) return false;
  const { data, error } = await cloud.database
    .from("events")
    .select("id")
    .eq("source_url", url)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}


// ---------- 个人画像 ----------
//
// 画像改存本机（localStorage），不再走云库 profiles 表。
//
// 原因不是性能，是安全：那张表的 owner_id 实测恒为字符串 'anon'，而且没有有效的
// 行级隔离——匿名 key 读得到别人的学院/年级/课程，也写得进去（整行覆盖）。
// 画像属于「只关于我」的数据，与课表、作业同级，放浏览器里既够用也不会串。
//
// 旧版本存过云的用户会走一次迁移：读到云上那行 → 落到本机 → 之后只用本机的。

export async function getProfile(): Promise<Profile | null> {
  const local = loadProfile();
  if (local) {
    return {
      college: local.college,
      major: local.major,
      grade: local.grade,
      level: local.level,
      courses: local.courses,
    };
  }

  /**
   * 云端迁移只在本机模式下做。
   *
   * 公网上这一步是有害的：profiles 表的 owner_id 恒为 'anon'，所有访客共用同一行，
   * 于是「本地为空」的新访客会把别人的学院画像读进自己浏览器，等于反向泄露。
   * 公网模式下本机没有画像就是没有，让用户自己选一次学院即可。
   */
  if (IS_PUBLIC_DEPLOY) return null;

  // 迁移：老数据还在云上，取一次搬到本机，之后不再读云
  try {
    const result = await cloud.database.from("profiles").select("*").maybeSingle();
    const data: any = result.data;
    if (result.error || !data) return null;
    const migrated: Profile = {
      college: data.college ?? undefined,
      major: data.major ?? undefined,
      grade: data.grade ?? undefined,
      level: data.level ?? undefined,
      courses: Array.isArray(data.courses) ? data.courses : [],
    };
    if (migrated.college || migrated.grade || migrated.courses.length) {
      saveLocalProfile(migrated);
    }
    return migrated;
  } catch {
    return null;
  }
}

export async function saveProfile(p: Profile) {
  saveLocalProfile({
    college: p.college,
    major: p.major,
    grade: p.grade,
    level: p.level,
    courses: p.courses || [],
  });
}

// ---------- 同步导入（浏览器插件 / 采集器） ----------
// 作业本身走 local-store 的 importDdls（本机），这里只剩画像课程合并。

/** 把同步来的课程名合并进个人画像，保留已有画像字段 */
export async function mergeProfileCourses(newCourses: string[]) {
  if (newCourses.length === 0) return { total: 0 };
  const current = (await getProfile()) || { courses: [] };
  const merged = Array.from(new Set([...current.courses, ...newCourses]));
  await saveProfile({ ...current, courses: merged });
  return { total: merged.length };
}

