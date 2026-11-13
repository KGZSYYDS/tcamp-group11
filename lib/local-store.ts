/**
 * 本机个人数据：课表 + 从微信/群聊排出的事，都存在浏览器本地，不进云端数据库。
 *
 * 为什么不进云库：课表和个人待办是「用户级、一学期一换」的临时数据。把它们塞进
 * 全校共享的 events 表，为了做到「只让本人看见」就得给每条记录打身份标记、再让用户
 * 认领，于是产生了本不该存在的归属争议（学号可枚举，谁先认领算谁的）。
 *
 * 现在的方式：本机脚本生成 JSON → 用户在「我的」页导入 → 存这里（localStorage）。
 * 云端只留公共数据，个人数据留在本人的浏览器里。换设备就重新跑一次采集。
 *
 * 两种文件格式：
 *   szu-calendar-timetable  课表（collect:timetable 生成）
 *   szu-calendar-personal   群聊里排出来的会议/截止（collect:meetings 生成）
 *
 * 2026-11-09 追加：作业截止（ddls）与签到记录（checkins）也搬进本机。
 *   它们属于「我的东西」这一层，与课表同级；跨设备同步本来就不是需求，
 *   放在云库反而多一处私人数据可读面。
 */

import type { Checkin, Ddl, DdlInput, DdlStatus } from "./types";

// ---------- 课表 ----------

export interface TimetableSession {
  kind: string;
  title: string;
  startAt: string;
  endAt?: string;
  allDay?: boolean;
  course?: string;
  location?: string | null;
  teacher?: string | null;
  week?: number;
  periods?: string;
}

export interface LocalProfile {
  name?: string;
  studentId?: string;
  college?: string;
  major?: string;
  className?: string;
  grade?: string;
  level?: string;
  levelName?: string;
  sex?: string;
}

export interface LocalTimetable {
  format: string;
  version: number;
  term: string;
  termName: string;
  week1Monday: string;
  currentWeek?: number | null;
  courses: string[];
  counts?: { courses: number; sessions: number };
  generatedAt?: string;
  profile?: LocalProfile;
  events: TimetableSession[];
  importedAt: string;
  fileName?: string;
}

// ---------- 个人待办（群聊里排出来的） ----------

export interface PersonalItem {
  kind: "meeting" | "deadline";
  title: string;
  startAt: string;
  endAt?: string;
  allDay?: boolean;
  location?: string | null;
  /** 来自哪个群 + 原话，方便回查 */
  note?: string;
  course?: string;
}

export interface LocalPersonal {
  format: "szu-calendar-personal";
  version: number;
  events: PersonalItem[];
  importedAt: string;
  fileName?: string;
}

const TKEY = "szu-calendar:timetable:v1";
const PKEY = "szu-calendar:personal:v1";

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * 本机数据变更时广播的事件名。
 *
 * 为什么不能只靠 `storage` 事件：`storage` 只在**别的标签页**写入时触发，
 * 当前页自己写 localStorage 是收不到的。
 * 于是「登录时自动拉畅课作业」写完 ddls，已经开着的 DDL 页完全不知道，
 * 用户看到的就是「登录成功了但作业还是没有」—— 必须手动刷新才出现。
 *
 * 所以凡是写本机数据的地方都调一次 `notifyLocalChange()`，
 * 各面板监听它（并且继续监听 storage 以覆盖多标签页）。
 */
export const LOCAL_CHANGE_EVENT = "szu-local-change";

export function notifyLocalChange() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

// ---------- 课表读写 ----------

export function loadTimetable(): LocalTimetable | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(TKEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as LocalTimetable;
    if (!t || !Array.isArray(t.events)) return null;
    return t;
  } catch {
    return null;
  }
}

export function saveTimetable(t: LocalTimetable) {
  if (!isBrowser()) return;
  window.localStorage.setItem(TKEY, JSON.stringify(t));
  notifyLocalChange();
}

export function clearTimetable() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(TKEY);
  notifyLocalChange();
}

/** 导入统计，用于给用户一句明确反馈（导入了什么、有多少、来自哪个文件） */
export function summarize(t: LocalTimetable) {
  const dates = t.events.map((e) => e.startAt.slice(0, 10)).sort();
  return {
    term: t.termName || t.term,
    courses: t.courses?.length || new Set(t.events.map((e) => e.course)).size,
    sessions: t.events.length,
    from: dates[0] || "",
    to: dates[dates.length - 1] || "",
  };
}

// ---------- 个人待办读写 ----------

export function loadPersonal(): LocalPersonal | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(PKEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as LocalPersonal;
    if (!p || !Array.isArray(p.events)) return null;
    return p;
  } catch {
    return null;
  }
}

export function savePersonal(p: LocalPersonal) {
  if (!isBrowser()) return;
  window.localStorage.setItem(PKEY, JSON.stringify(p));
  notifyLocalChange();
}

export function clearPersonal() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(PKEY);
  notifyLocalChange();
}

/** 同一条事在两次采集里可能重来一遍：按「日期+标题+类型」合并，后到的覆盖先到的 */
function itemKey(e: PersonalItem) {
  return `${e.startAt.slice(0, 10)}|${e.kind}|${e.title}`;
}

// ---------- 个人画像（本机） ----------

/**
 * 画像（学院 / 专业 / 年级 / 本学期的课）同样不该放云端。
 *
 * 之前它存在云库 `profiles` 表里，配的是 `.maybeSingle()`——一句不带过滤条件的查询，
 * 靠 RLS 兜底。实测那张表的 owner_id 恒为字符串 'anon'，匿名 key 既能读到别人的
 * 学院年级，也能整行覆盖。公网一放出去，等于把每个人的画像摊开，还允许任何人改。
 *
 * 与 ddls 一样，这类「只关于我、换设备也不心疼」的数据放本机最省事也最安全。
 */
const PROFILE_KEY = "szu-calendar:profile:v1";

export interface StoredProfile {
  college?: string;
  major?: string;
  grade?: string;
  level?: string;
  courses: string[];
  savedAt?: string;
}

export function loadProfile(): StoredProfile | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredProfile;
    if (!p || typeof p !== "object") return null;
    return { ...p, courses: Array.isArray(p.courses) ? p.courses.filter((c) => typeof c === "string") : [] };
  } catch {
    return null;
  }
}

export function saveLocalProfile(p: StoredProfile) {
  if (!isBrowser()) return;
  window.localStorage.setItem(
    PROFILE_KEY,
    JSON.stringify({
      college: p.college?.trim() || undefined,
      major: p.major?.trim() || undefined,
      grade: p.grade?.trim() || undefined,
      level: p.level || undefined,
      courses: Array.from(new Set((p.courses || []).map((c) => c.trim()).filter(Boolean))),
      savedAt: new Date().toISOString(),
    })
  );
}

export function clearProfile() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(PROFILE_KEY);
}

// ---------- 作业 / 截止日期（本机） ----------

/**
 * 作业 DDL 与课表同级：本学期的、自己的、一换就作废。
 * 以前的实现走云库 `ddls` 表，游客态写不进去、登录后还会跨账号串，
 * 而这张表对匿名 key 是敞开的 —— 没有理由继续放云上。
 */
const DDL_KEY = "szu-calendar:ddls:v1";
const CHECKIN_KEY = "szu-calendar:checkins:v1";

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadDdls(): Ddl[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(DDL_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return (arr as Ddl[]).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  } catch {
    return [];
  }
}

function saveDdls(list: Ddl[]) {
  if (!isBrowser()) return;
  window.localStorage.setItem(DDL_KEY, JSON.stringify(list));
  // 所有 ddls 写操作都走这里，广播一次就够
  notifyLocalChange();
}

export function addDdl(input: DdlInput): Ddl {
  const ddl: Ddl = {
    id: uid("d"),
    course: input.course.trim(),
    title: input.title.trim(),
    dueAt: new Date(input.dueAt).toISOString(),
    url: input.url?.trim() || undefined,
    note: input.note?.trim() || undefined,
    status: "pending",
    source: input.source || "manual",
    createdAt: new Date().toISOString(),
  };
  saveDdls([...loadDdls(), ddl]);
  return ddl;
}

export function setDdlStatus(id: string, status: DdlStatus): boolean {
  const list = loadDdls();
  const i = list.findIndex((d) => d.id === id);
  if (i === -1) return false;
  list[i] = { ...list[i], status };
  saveDdls(list);
  return true;
}

export function removeDdl(id: string): boolean {
  const list = loadDdls();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) return false;
  saveDdls(next);
  return true;
}

/**
 * 批量导入（畅课插件 / 粘贴作业列表）。
 * 业务主键仍是 course + title：同一条作业重复导入只更新时间，不动「已完成」状态。
 */
export function importDdls(inputs: DdlInput[]) {
  const list = loadDdls();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const input of inputs) {
    if (!input?.course || !input?.title || !input?.dueAt) {
      skipped++;
      continue;
    }
    const due = new Date(input.dueAt);
    if (Number.isNaN(due.getTime())) {
      skipped++;
      continue;
    }
    const dup = list.find(
      (d) =>
        // url 里带 course_id + material_id，是最稳的主键。
        // 只按 course+title 匹配时，畅课拿不到课程名会退化成「未匹配课程」，
        // 下次拿到真名就变成两条同一作业。
        (input.url && d.url && d.url.trim() === input.url.trim()) ||
        (d.course === input.course.trim() && d.title === input.title.trim())
    );
    if (dup) {
      if (new Date(dup.dueAt).getTime() === due.getTime()) {
        // 时间没变，但课程名可能从占位值变成了真名，跟着更新而不是新增
        if (dup.course !== input.course.trim()) {
          dup.course = input.course.trim();
          updated++;
        } else {
          skipped++;
        }
      } else {
        dup.dueAt = due.toISOString();
        if (input.url) dup.url = input.url.trim();
        if (input.note) dup.note = input.note.trim();
        updated++;
      }
    } else {
      list.push({
        id: uid("d"),
        course: input.course.trim(),
        title: input.title.trim(),
        dueAt: due.toISOString(),
        url: input.url?.trim() || undefined,
        note: input.note?.trim() || undefined,
        status: "pending",
        source: input.source || "lms-sync",
        createdAt: new Date().toISOString(),
      });
      added++;
    }
  }

  saveDdls(list);
  return { added, updated, skipped };
}

// ---------- 签到记录（本机） ----------

export function loadCheckins(): Checkin[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(CHECKIN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return (arr as Checkin[]).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  } catch {
    return [];
  }
}

function saveCheckins(list: Checkin[]) {
  if (!isBrowser()) return;
  window.localStorage.setItem(CHECKIN_KEY, JSON.stringify(list));
  notifyLocalChange();
}

export function removeCheckin(id: string): boolean {
  const list = loadCheckins();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  saveCheckins(next);
  return true;
}

// ---------- 自建事件（日历里手动加的「仅自己」） ----------

/**
 * 手动新建的「仅自己」事件也留在本机。
 *
 * 以前它走 createEvent 写云库的 events 表，结果是这张全校共享表里混进了 personal 行：
 * 拿发布用的匿名 key 就能把 211 行私人安排整批读回来，等于发给了每个访客。
 * 公共进云、个人留本机，这条线在这里补齐。
 */
export interface MyEvent {
  id: string;
  kind: string;
  source?: "paste-import";
  title: string;
  startAt: string;
  endAt?: string;
  allDay: boolean;
  link?: string;
  course?: string;
  location?: string;
  note?: string;
  createdAt: string;
}

const MYKEY = "szu-calendar:my-events:v1";

export function loadMyEvents(): MyEvent[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(MYKEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as MyEvent[]) : [];
  } catch {
    return [];
  }
}

function saveMyEvents(list: MyEvent[]) {
  if (!isBrowser()) return;
  window.localStorage.setItem(MYKEY, JSON.stringify(list));
  notifyLocalChange();
}

export function addMyEvent(input: Omit<MyEvent, "id" | "createdAt">): MyEvent {
  const ev: MyEvent = {
    ...input,
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  saveMyEvents([...loadMyEvents(), ev]);
  return ev;
}

export function removeMyEvent(id: string) {
  saveMyEvents(loadMyEvents().filter((e) => e.id !== id));
}

// ---------- 公共截止的「已完成」标记 ----------

/**
 * 公文通的报名截止是公共的，没有「谁完成了」这回事，云端也不该记。
 * 但用户自己需要勾掉「这条我交过了」——那就只记在本机：一个 key 的集合。
 */
const DONE_KEY = "szu-calendar:ddl-done:v1";

export function loadDoneKeys(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(DONE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function toggleDoneKey(key: string): string[] {
  if (!isBrowser()) return [];
  const set = new Set(loadDoneKeys());
  if (set.has(key)) set.delete(key);
  else set.add(key);
  const next = [...set];
  window.localStorage.setItem(DONE_KEY, JSON.stringify(next));
  notifyLocalChange();
  return next;
}

export function mergePersonal(prev: PersonalItem[], next: PersonalItem[]): PersonalItem[] {
  const map = new Map<string, PersonalItem>();
  for (const e of prev) map.set(itemKey(e), e);
  for (const e of next) map.set(itemKey(e), e);
  return [...map.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

// ---------- 解析导入文件 ----------

/**
 * 解析用户选中的 JSON 文件。只接受本项目的两种导出格式，
 * 不猜结构——猜错会把别的 JSON 塞进日历，排查起来很痛苦。
 *
 * 兼容 v0 旧格式（字段是 start_at / end_at / all_day，没有 format 标记）：
 * 升级前生成的 timetable-*.json 依然能导入，不必重新跑一遍采集。
 */
export function parseTimetableFile(text: string, fileName = ""): LocalTimetable {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("这个文件不是 JSON，确认选的是脚本生成的 timetable-*.json");
  }
  const o = j as Record<string, unknown>;
  const legacy = !o.format && Array.isArray(o.events);

  if (o.format !== "szu-calendar-timetable" && !legacy) {
    throw new Error(
      "文件格式不匹配：请选脚本生成的 timetable-<学期>.json（format 字段为 szu-calendar-timetable）"
    );
  }
  const rawEvents = o.events as Record<string, unknown>[];
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error("文件里没有课程事件，可能是采集时课表为空");
  }

  const events: TimetableSession[] = rawEvents.map((e) => {
    const start = (e.startAt || e.start_at || "") as string;
    const end = (e.endAt || e.end_at || "") as string | null;
    return {
      kind: (e.kind as string) || "other",
      title: (e.title as string) || "",
      startAt: start,
      endAt: end || undefined,
      allDay: Boolean(e.allDay ?? e.all_day),
      course: (e.course as string) || undefined,
      location: (e.location as string) || undefined,
      teacher: (e.teacher as string) || undefined,
      week: typeof e.week === "number" ? e.week : undefined,
      periods: (e.periods as string) || undefined,
    };
  });

  return {
    format: "szu-calendar-timetable",
    version: Number(o.version) || 1,
    term: (o.term as string) || "",
    termName: (o.termName as string) || (o.term as string) || "",
    week1Monday: (o.week1Monday as string) || "",
    currentWeek: typeof o.currentWeek === "number" ? o.currentWeek : null,
    courses: (o.courses as string[]) || [],
    counts: o.counts as { courses: number; sessions: number } | undefined,
    generatedAt: (o.generatedAt as string) || undefined,
    profile: o.profile as LocalProfile | undefined,
    events,
    importedAt: new Date().toISOString(),
    fileName,
  };
}

export function parsePersonalFile(text: string, fileName = ""): LocalPersonal {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("这个文件不是 JSON，确认选的是脚本生成的 meetings-*.json");
  }
  const o = j as Record<string, unknown>;
  if (o.format !== "szu-calendar-personal") {
    throw new Error(
      "文件格式不匹配：请选 collect:meetings 生成的 meetings-*.json（format 字段为 szu-calendar-personal）"
    );
  }
  const raw = o.events as Record<string, unknown>[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("文件里没有事项，可能是这次扫描没提到任何时间");
  }

  const events: PersonalItem[] = raw
    .map((e) => ({
      kind: (e.kind === "deadline" ? "deadline" : "meeting") as PersonalItem["kind"],
      title: String(e.title || ""),
      startAt: String(e.startAt || ""),
      endAt: (e.endAt as string) || undefined,
      allDay: Boolean(e.allDay),
      location: (e.location as string) || null,
      note: (e.note as string) || undefined,
    }))
    .filter((e) => e.title && e.startAt);

  if (!events.length) throw new Error("文件里没有可用的标题/时间，检查脚本输出");

  return {
    format: "szu-calendar-personal",
    version: Number(o.version) || 1,
    events,
    importedAt: new Date().toISOString(),
    fileName,
  };
}

/** 一个按钮吃两种文件：看 format 字段决定进哪个库 */
export type ImportResult =
  | { type: "timetable"; data: LocalTimetable }
  | { type: "personal"; data: LocalPersonal; merged: number; total: number };

export function importFile(text: string, fileName = ""): ImportResult {
  let head: unknown;
  try {
    head = JSON.parse(text);
  } catch {
    throw new Error("这个文件不是 JSON，请选脚本生成的 timetable-*.json 或 meetings-*.json");
  }
  const fmt = (head as Record<string, unknown>)?.format;
  if (fmt === "szu-calendar-personal") {
    const data = parsePersonalFile(text, fileName);
    const prev = loadPersonal()?.events || [];
    const mergedEvents = mergePersonal(prev, data.events);
    const withMerged = { ...data, events: mergedEvents };
    savePersonal(withMerged);
    return {
      type: "personal",
      data: withMerged,
      merged: mergedEvents.length - prev.length,
      total: mergedEvents.length,
    };
  }
  if (fmt && fmt !== "szu-calendar-timetable") {
    throw new Error(
      "文件格式不匹配：只认 timetable-*.json（format=szu-calendar-timetable）和 meetings-*.json（format=szu-calendar-personal）"
    );
  }
  const data = parseTimetableFile(text, fileName);
  saveTimetable(data);
  return { type: "timetable", data };
}
