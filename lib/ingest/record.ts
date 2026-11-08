import type { MissingField, RawRecord, RawRecordStructured } from "./types";
import { canonicalUrl } from "../pipeline/normalize";

/**
 * 组装内部记录。
 * 原则：**不猜**。缺什么就记什么，不用默认值填充，避免下游把空值当真实数据。
 */
export function makeRawRecord(input: {
  collector: string;
  receivedAt: string;
  url?: string;
  title?: string;
  content?: string;
  publishedAt?: string;
  department?: string;
  externalId?: string;
  structured?: RawRecordStructured;
  context?: Record<string, string>;
}): RawRecord {
  const url = canonicalUrl(input.url || "");
  const title = (input.title || "").trim();
  const content = (input.content || "").trim();
  const hasStructuredTime = Boolean(input.structured?.occurAt);

  const missing: MissingField[] = [];
  if (!url) missing.push("url");
  if (!title) missing.push("title");
  // 平台自带结构化时间时，正文缺失不构成阻塞（畅课待办就是这种情况）
  if (content.length < 20 && !hasStructuredTime) missing.push("content");
  if (!input.publishedAt) missing.push("publishedAt");
  if (!input.externalId) missing.push("stableId");

  return {
    collector: input.collector,
    url,
    title,
    content,
    receivedAt: input.receivedAt,
    publishedAt: input.publishedAt,
    department: input.department?.trim() || undefined,
    externalId: input.externalId?.trim() || undefined,
    structured: input.structured,
    context: input.context,
    missing,
  };
}

/** 时间基准：发布时间优先，缺失退收到时间。绝不用“现在”，否则补采会漂移。 */
export function anchorOf(record: RawRecord): string {
  return record.publishedAt || record.receivedAt;
}
