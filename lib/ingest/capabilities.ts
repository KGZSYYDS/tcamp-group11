import type { RawRecord } from "./types";

/**
 * 能力审计：不检查"字段名对不对"，只检查"这 5 件事答不答得上来"。
 *
 * 采集方格式可以随便定，但只要缺了 blocking 项，管道就跑不通——这是沟通时唯一要对齐的东西。
 */

export type CapabilityKey =
  | "traceable"
  | "content"
  | "provenance"
  | "publishedTime"
  | "stableIdentity";

export interface CapabilityReport {
  key: CapabilityKey;
  label: string;
  question: string;
  /** 是否满足 */
  ok: boolean;
  /** 满足但会降级（例如用内容哈希替代平台 id） */
  degraded: boolean;
  severity: "blocking" | "degradable";
  missingCount: number;
  hint: string;
}

export interface AuditResult {
  total: number;
  /** 无 blocking 缺失即为 true */
  ready: boolean;
  reports: CapabilityReport[];
  /** 需要对方补齐的项 */
  blocking: CapabilityReport[];
}

function count(records: RawRecord[], predicate: (r: RawRecord) => boolean): number {
  return records.reduce((n, r) => (predicate(r) ? n : n + 1), 0);
}

export function auditCapabilities(records: RawRecord[]): AuditResult {
  const total = records.length;

  const missingUrl = count(records, (r) => Boolean(r.url));
  const missingContent = count(
    records,
    (r) => r.content.length >= 20 || Boolean(r.structured?.occurAt)
  );
  const missingCollector = count(records, (r) => Boolean(r.collector));
  const missingPublished = count(records, (r) => Boolean(r.publishedAt));
  const missingStableId = count(records, (r) => Boolean(r.externalId));

  const reports: CapabilityReport[] = [
    {
      key: "traceable",
      label: "可回溯到原文",
      question: "这条记录指向哪个原始页面？",
      ok: total > 0 && missingUrl === 0,
      degraded: false,
      severity: "blocking",
      missingCount: missingUrl,
      hint: "没有链接就无法去重，用户也无法核对原文",
    },
    {
      key: "content",
      label: "原文正文",
      question: "有没有未经加工的正文？",
      ok: total > 0 && missingContent === 0,
      degraded: false,
      severity: "blocking",
      missingCount: missingContent,
      hint: "摘要版会让日期证据校验失效，必须是原文",
    },
    {
      key: "provenance",
      label: "来源标识",
      question: "知不知道这条来自哪个平台？",
      ok: total > 0 && missingCollector === 0,
      degraded: false,
      severity: "blocking",
      missingCount: missingCollector,
      hint: "决定跨源去重时保留哪一份（官网原文优先）",
    },
    {
      key: "publishedTime",
      label: "发布时间",
      question: "有没有原文的发布时间？",
      ok: total > 0 && missingPublished === 0,
      degraded: missingPublished > 0 && missingPublished < total,
      severity: "degradable",
      missingCount: missingPublished,
      hint: "缺失时退回抓取时间，但“下周三”这类相对时间会算偏",
    },
    {
      key: "stableIdentity",
      label: "稳定标识",
      question: "重复采集同一条时，能不能给同一个标识？",
      ok: total > 0 && missingStableId === 0,
      degraded: missingStableId === total,
      severity: "degradable",
      missingCount: missingStableId,
      hint: "没有平台 id 时用正文指纹兜底，改标题的转载会漏判",
    },
  ];

  const blocking = reports.filter((r) => r.severity === "blocking" && !r.ok);

  return { total, ready: total > 0 && blocking.length === 0, reports, blocking };
}

/** 供控制台打印的一行摘要 */
export function summarizeAudit(result: AuditResult): string {
  if (result.total === 0) return "没有可审计的记录";
  const okCount = result.reports.filter((r) => r.ok).length;
  const degraded = result.reports.filter((r) => r.degraded).map((r) => r.label);
  const base = `${result.total} 条记录，${okCount}/${result.reports.length} 项能力满足`;
  const tail = result.ready ? "可用于入库" : `缺：${result.blocking.map((r) => r.label).join("、")}`;
  return degraded.length ? `${base}（降级：${degraded.join("、")}）— ${tail}` : `${base} — ${tail}`;
}
