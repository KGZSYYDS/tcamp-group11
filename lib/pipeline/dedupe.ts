import type { EventKind } from "../types";
import { canonicalUrl } from "./normalize";
import { contentFingerprint, titleSimilarity } from "./fingerprint";
import { dayDiff } from "./time";

/**
 * 三级去重。
 *
 * L1 精确：同一原文链接 / 同一平台 id —— 最强，直接判定为同一条
 * L2 内容：正文指纹相同 —— 应对转载、参数不同但正文一致
 * L3 语义：同类别 + 日期相差 ≤1 天 + 标题相似度 ≥0.72 —— 应对"改了标题的转发"
 *
 * 跨源同时命中时按权威性保留一份：官网原文 > 邮件 > 群消息转发。
 */

export const SOURCE_AUTHORITY: Record<string, number> = {
  "gwt-board": 100,
  mail: 80,
  "lms-todos": 70,
  "lms-activity": 70,
  paste: 40,
  manual: 30,
};

export interface DedupeCandidate {
  collector: string;
  url: string;
  title: string;
  body: string;
  kind: EventKind;
  occurAt: string | null;
  /** 平台内稳定 id；没有原文链接时靠它精确去重 */
  externalId?: string;
}

export interface DedupePoolItem {
  id: string;
  collector?: string;
  url?: string;
  externalId?: string;
  title?: string;
  fingerprint?: string;
  kind?: EventKind;
  occurAt?: string | null;
}

export type DedupeAction = "insert" | "update" | "merge" | "skip";

export interface DedupeDecision {
  action: DedupeAction;
  targetId?: string;
  reason: string;
  score?: number;
}

const SEMANTIC_THRESHOLD = 0.72;

export function authorityOf(collector: string): number {
  return SOURCE_AUTHORITY[collector] ?? 10;
}

export function dedupe(
  candidate: DedupeCandidate,
  pool: DedupePoolItem[] = []
): DedupeDecision {
  const url = canonicalUrl(candidate.url);
  const fingerprint = contentFingerprint(`${candidate.title}\n${candidate.body}`);

  // L1 精确链接
  if (url) {
    const sameUrl = pool.find((item) => item.url && canonicalUrl(item.url) === url);
    if (sameUrl) {
      if (!sameUrl.collector || sameUrl.collector === candidate.collector) {
        return { action: "skip", targetId: sameUrl.id, reason: "同一原文链接" };
      }
      const mine = authorityOf(candidate.collector);
      const theirs = authorityOf(sameUrl.collector);
      return {
        action: mine > theirs ? "update" : "merge",
        targetId: sameUrl.id,
        reason:
          mine > theirs
            ? `同一原文链接，本来源(${candidate.collector})更权威，覆盖已有记录`
            : `同一原文链接，已有来源(${sameUrl.collector})更权威，仅合并提及`,
      };
    }
  }

  // L1.5 平台稳定 id（畅课待办这类没有独立页面的数据靠这条）
  if (candidate.externalId) {
    const sameId = pool.find(
      (item) => item.externalId && item.externalId === candidate.externalId
    );
    if (sameId) {
      return { action: "skip", targetId: sameId.id, reason: "同一平台记录 id" };
    }
  }

  // L2 正文指纹
  const sameContent = pool.find((item) => item.fingerprint && item.fingerprint === fingerprint);
  if (sameContent) {
    return { action: "skip", targetId: sameContent.id, reason: "正文指纹一致" };
  }

  // L3 语义近似
  if (candidate.occurAt) {
    let best: { item: DedupePoolItem; score: number } | null = null;
    for (const item of pool) {
      if (!item.occurAt || !item.title) continue;
      if (item.kind && item.kind !== candidate.kind) continue;
      const gap = Math.abs(dayDiff(item.occurAt, candidate.occurAt));
      if (gap > 1) continue;
      const score = titleSimilarity(candidate.title, item.title);
      if (score >= SEMANTIC_THRESHOLD && (!best || score > best.score)) {
        best = { item, score };
      }
    }
    if (best) {
      return {
        action: "merge",
        targetId: best.item.id,
        reason: `标题相似度 ${(best.score * 100).toFixed(0)}%，日期相差 ≤1 天`,
        score: best.score,
      };
    }
  }

  return { action: "insert", reason: "未命中已有记录" };
}

export function candidateOf(input: {
  collector: string;
  url: string;
  title: string;
  body: string;
  kind: EventKind;
  occurAt: string | null;
}): DedupeCandidate {
  return input;
}
