import { cloud } from "./cloud";
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
 * 只取公共事件。personal 行一律在服务端过滤掉，不下发到浏览器——
 * 个人数据本来就不该进这张表，这里是不让历史脏数据继续外泄的第二道闸。
 */
export async function listEvents(): Promise<CalEvent[]> {
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
      createdAt: r.created_at,
    }));
  } finally {
    clearTimeout(timer);
  }
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
}

export async function deleteEvent(id: string) {
  const { data, error } = await cloud.database
    .from("events")
    .delete()
    .eq("id", Number(id))
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
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

export async function getProfile(): Promise<Profile | null> {
  const result = await cloud.database.from("profiles").select("*").maybeSingle();
  const data: any = result.data;
  if (result.error) throw new Error(result.error.message);
  if (!data) return null;
  return {
    college: data.college ?? undefined,
    major: data.major ?? undefined,
    grade: data.grade ?? undefined,
    level: data.level ?? undefined,
    courses: data.courses ?? [],
  };
}

export async function saveProfile(p: Profile) {
  const { data, error } = await cloud.database
    .from("profiles")
    .upsert(
      {
        college: p.college?.trim() || null,
        major: p.major?.trim() || null,
        grade: p.grade?.trim() || null,
        level: p.level || null,
        courses: p.courses,
      } as any,
      { onConflict: "owner_id" }
    )
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
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

