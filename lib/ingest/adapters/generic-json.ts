import type { Adapter, RawRecord } from "../types";
import { makeRawRecord } from "../record";
import { htmlToText, normalizeSpace } from "../../pipeline/normalize";

/**
 * 通用 JSON 适配器：对方格式未定时的兜底。
 *
 * 思路来自 extension/parser.js 的 walkNotice —— 深度遍历，按候选键名试探取值。
 * 它不是"格式规范"，只是让管道在格式确定前也能跑。
 * 专用适配器一旦写好，优先级高于它。
 */

const TITLE_KEYS = ["title", "noticeTitle", "subject", "headline", "name", "标题"];
const CONTENT_KEYS = [
  "content", "contentHtml", "body", "html", "text", "detail",
  "summary", "desc", "description", "正文", "内容",
];
const URL_KEYS = ["url", "link", "href", "sourceUrl", "source_url", "detailUrl"];
const TIME_KEYS = [
  "publishedAt", "publishTime", "publishDate", "publish_time", "createTime",
  "createdAt", "created_at", "releaseTime", "date", "发布时间",
];
const ID_KEYS = ["id", "externalId", "external_id", "noticeId", "articleId", "uuid"];
const DEPT_KEYS = ["department", "dept", "deptName", "unit", "org", "author", "发布单位"];

const MAX_DEPTH = 6;

function firstString(obj: Record<string, unknown>, keys: string[], min = 0): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length >= min) return text;
    } else if (typeof value === "number") {
      return String(value);
    }
  }
  return undefined;
}

function toText(value: string): string {
  const text = /<\/?[a-z][\s\S]*>/i.test(value) ? htmlToText(value) : value;
  return normalizeSpace(text);
}

function looksLikeRecord(obj: Record<string, unknown>): boolean {
  if (!firstString(obj, TITLE_KEYS, 4)) return false;
  return Boolean(firstString(obj, CONTENT_KEYS, 20) || firstString(obj, URL_KEYS, 4));
}

function pickRecord(obj: Record<string, unknown>): RawRecord | null {
  const title = firstString(obj, TITLE_KEYS, 2);
  const content = firstString(obj, CONTENT_KEYS, 20);
  const url = firstString(obj, URL_KEYS, 4);
  if (!title || (!content && !url)) return null;

  const publishedRaw = firstString(obj, TIME_KEYS, 4);

  return makeRawRecord({
    collector: "",
    receivedAt: "",
    url,
    title,
    content: content ? toText(content) : "",
    publishedAt: publishedRaw ? normalizeTime(publishedRaw) : undefined,
    department: firstString(obj, DEPT_KEYS, 2),
    externalId: firstString(obj, ID_KEYS, 1),
  });
}

/** 各种时间写法尽量统一到 ISO；解析不了就留空（不编） */
export function normalizeTime(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();

  const cn = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?(?:[ T]?(\d{1,2})[:：](\d{1,2}))?/.exec(text);
  if (cn) {
    const [, y, m, d, hh, mm] = cn;
    const pad = (n?: string) => String(n ?? "0").padStart(2, "0");
    return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00+08:00`;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function walk(node: unknown, out: Array<Record<string, unknown>>, depth: number): void {
  if (depth > MAX_DEPTH || node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  if (looksLikeRecord(obj)) {
    // 命中后不再深入，避免把同一条记录的子字段重复算成新记录
    out.push(obj);
    return;
  }

  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child && typeof child === "object") walk(child, out, depth + 1);
  }
}

export const genericJsonAdapter: Adapter = (payload, ctx) => {
  const found: Array<Record<string, unknown>> = [];
  walk(payload, found, 0);

  const records: RawRecord[] = [];
  const seen = new Set<string>();

  for (const obj of found) {
    const raw = pickRecord(obj);
    if (!raw) continue;

    const key = `${raw.url}|${raw.title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    records.push({ ...raw, collector: ctx.collector, receivedAt: ctx.receivedAt });
  }

  return records;
};
