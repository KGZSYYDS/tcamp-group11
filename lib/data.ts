import { cloud } from "./cloud";
import type {
  CalEvent,
  CalEventInput,
  Checkin,
  CheckinInput,
  Ddl,
  DdlInput,
  Profile,
} from "./types";

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

// ---------- DDL ----------

export async function listDdls(): Promise<Ddl[]> {
  const rows = unwrap(
    await cloud.database.from("ddls").select("*").order("due_at", { ascending: true })
  ) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    course: r.course,
    title: r.title,
    dueAt: r.due_at,
    url: r.url ?? undefined,
    note: r.note ?? undefined,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export async function createDdl(input: DdlInput) {
  const { data, error } = await cloud.database
    .from("ddls")
    .insert({
      course: input.course.trim(),
      title: input.title.trim(),
      due_at: new Date(input.dueAt).toISOString(),
      url: input.url?.trim() || null,
      note: input.note?.trim() || null,
      source: input.source || "manual",
    } as any)
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
}

export async function setDdlStatus(id: string, status: "pending" | "done") {
  const { data, error } = await cloud.database
    .from("ddls")
    .update({ status } as never)
    .eq("id", Number(id))
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
}

export async function deleteDdl(id: string) {
  const { data, error } = await cloud.database
    .from("ddls")
    .delete()
    .eq("id", Number(id))
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
}

// ---------- 签到 ----------

export async function listCheckins(): Promise<Checkin[]> {
  const rows = unwrap(
    await cloud.database
      .from("checkins")
      .select("*")
      .order("occurred_at", { ascending: false })
  ) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    course: r.course,
    teacher: r.teacher ?? undefined,
    occurredAt: r.occurred_at,
    note: r.note ?? undefined,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export async function createCheckin(input: CheckinInput) {
  const { data, error } = await cloud.database
    .from("checkins")
    .insert({
      course: input.course.trim(),
      teacher: input.teacher?.trim() || null,
      occurred_at: new Date(input.occurredAt).toISOString(),
      note: input.note?.trim() || null,
      source: input.source || "manual",
    } as any)
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
}

export async function deleteCheckin(id: string) {
  const { data, error } = await cloud.database
    .from("checkins")
    .delete()
    .eq("id", Number(id))
    .select();
  if (error) throw new Error(error.message);
  assertAffected(data);
}

// ---------- 日历事件 ----------

export async function listEvents(): Promise<CalEvent[]> {
  const rows = unwrap(
    await cloud.database.from("events").select("*").order("start_at", { ascending: true })
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

/** 按 课程+标题 去重导入 DDL：已存在且截止时间一致则跳过，不一致则更新时间 */
export async function importDdls(inputs: DdlInput[]) {
  const existing = await listDdls();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const input of inputs) {
    const dup = existing.find(
      (d) => d.course === input.course && d.title === input.title
    );
    if (dup) {
      const sameTime =
        new Date(dup.dueAt).getTime() === new Date(input.dueAt).getTime();
      if (sameTime) {
        skipped++;
      } else {
        const { error } = await cloud.database
          .from("ddls")
          .update({ due_at: new Date(input.dueAt).toISOString() } as never)
          .eq("id", Number(dup.id));
        if (error) throw new Error(error.message);
        updated++;
      }
    } else {
      await createDdl({ ...input, source: input.source || "lms-sync" });
      added++;
    }
  }
  return { added, updated, skipped };
}

/** 把同步来的课程名合并进个人画像，保留已有画像字段 */
export async function mergeProfileCourses(newCourses: string[]) {
  if (newCourses.length === 0) return { total: 0 };
  const current = (await getProfile()) || { courses: [] };
  const merged = Array.from(new Set([...current.courses, ...newCourses]));
  await saveProfile({ ...current, courses: merged });
  return { total: merged.length };
}

