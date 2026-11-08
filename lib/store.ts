import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { CalEvent, CalEventInput, Checkin, CheckinInput, Ddl, DdlInput } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "ddls.json");
const CHECKIN_FILE = path.join(DATA_DIR, "checkins.json");
const EVENT_FILE = path.join(DATA_DIR, "events.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf-8");
}

export function listDdls(): Ddl[] {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const items: Ddl[] = JSON.parse(raw);
  return items.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function saveAll(items: Ddl[]) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export function createDdl(input: DdlInput): Ddl {
  const items = listDdls();
  const ddl: Ddl = {
    id: crypto.randomUUID(),
    course: input.course.trim(),
    title: input.title.trim(),
    dueAt: new Date(input.dueAt).toISOString(),
    url: input.url?.trim() || undefined,
    note: input.note?.trim() || undefined,
    status: "pending",
    source: input.source || "manual",
    createdAt: new Date().toISOString(),
  };
  items.push(ddl);
  saveAll(items);
  return ddl;
}

export function updateDdl(id: string, patch: Partial<Ddl>): Ddl | null {
  const items = listDdls();
  const idx = items.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], ...patch, id };
  saveAll(items);
  return items[idx];
}

export function deleteDdl(id: string): boolean {
  const items = listDdls();
  const next = items.filter((d) => d.id !== id);
  if (next.length === items.length) return false;
  saveAll(next);
  return true;
}

/**
 * 批量导入（采集器入口）。
 * 以 course + title 作为业务主键：
 *  - 不存在则新增；
 *  - 已存在则更新 dueAt / url / note，保留完成状态。
 * 返回统计，方便采集器记录日志。
 */
export function importDdls(inputs: DdlInput[], source: string) {
  const items = listDdls();
  let added = 0;
  let updated = 0;
  for (const input of inputs) {
    if (!input.course || !input.title || !input.dueAt) continue;
    const existing = items.find(
      (d) => d.course === input.course.trim() && d.title === input.title.trim()
    );
    if (existing) {
      existing.dueAt = new Date(input.dueAt).toISOString();
      if (input.url) existing.url = input.url.trim();
      if (input.note) existing.note = input.note.trim();
      updated++;
    } else {
      items.push({
        id: crypto.randomUUID(),
        course: input.course.trim(),
        title: input.title.trim(),
        dueAt: new Date(input.dueAt).toISOString(),
        url: input.url?.trim() || undefined,
        note: input.note?.trim() || undefined,
        status: "pending",
        source,
        createdAt: new Date().toISOString(),
      });
      added++;
    }
  }
  saveAll(items);
  return { added, updated, total: items.length };
}

// ---------- 签到事件 ----------

export function listCheckins(): Checkin[] {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHECKIN_FILE)) fs.writeFileSync(CHECKIN_FILE, "[]", "utf-8");
  const items: Checkin[] = JSON.parse(fs.readFileSync(CHECKIN_FILE, "utf-8"));
  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function saveCheckins(items: Checkin[]) {
  fs.writeFileSync(CHECKIN_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export function createCheckin(input: CheckinInput): Checkin {
  const items = listCheckins();
  const checkin: Checkin = {
    id: crypto.randomUUID(),
    course: input.course.trim(),
    teacher: input.teacher?.trim() || undefined,
    occurredAt: new Date(input.occurredAt).toISOString(),
    note: input.note?.trim() || undefined,
    source: input.source || "manual",
    createdAt: new Date().toISOString(),
  };
  items.push(checkin);
  saveCheckins(items);
  return checkin;
}

export function deleteCheckin(id: string): boolean {
  const items = listCheckins();
  const next = items.filter((c) => c.id !== id);
  if (next.length === items.length) return false;
  saveCheckins(next);
  return true;
}

// ---------- 通用日历事件 ----------

const EVENT_KINDS = ["exam", "pe", "activity", "other"];

export function listEvents(): CalEvent[] {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENT_FILE)) fs.writeFileSync(EVENT_FILE, "[]", "utf-8");
  const items: CalEvent[] = JSON.parse(fs.readFileSync(EVENT_FILE, "utf-8"));
  return items.sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export function createEvent(input: CalEventInput): CalEvent {
  const items = listEvents();
  const event: CalEvent = {
    id: crypto.randomUUID(),
    kind: EVENT_KINDS.includes(input.kind) ? input.kind : "other",
    title: input.title.trim(),
    startAt: new Date(input.startAt).toISOString(),
    allDay: Boolean(input.allDay),
    course: input.course?.trim() || undefined,
    location: input.location?.trim() || undefined,
    note: input.note?.trim() || undefined,
    scope: input.scope || "personal",
    source: input.source || "manual",
    createdAt: new Date().toISOString(),
  };
  items.push(event);
  fs.writeFileSync(EVENT_FILE, JSON.stringify(items, null, 2), "utf-8");
  return event;
}

export function deleteEvent(id: string): boolean {
  const items = listEvents();
  const next = items.filter((e) => e.id !== id);
  if (next.length === items.length) return false;
  fs.writeFileSync(EVENT_FILE, JSON.stringify(next, null, 2), "utf-8");
  return true;
}


