import { anchorOf } from "../ingest/record";
import type { RawRecord } from "../ingest/types";
import type { DedupeDecision, DedupePoolItem } from "./dedupe";
import { dedupe } from "./dedupe";
import type { EventDraft, IngestStatus } from "./draft";
import { contentFingerprint } from "./fingerprint";
import { noopExtractor, type ExtractorFn } from "./extract/llm";
import { crossCheck } from "./extract/merge";
import { extractByRules } from "./extract/rules";
import { normalizeText } from "./normalize";

/**
 * 管道编排：一条原始记录 → 一份带置信度的草稿。
 *
 * 全部外部依赖（模型、已有数据）通过 deps 注入，因此：
 * - 测试时不需要连数据库、不需要真模型
 * - 换模型、换存储都不影响这段逻辑
 */

export interface IngestDeps {
  extractor?: ExtractorFn;
  pool?: DedupePoolItem[];
}

export interface IngestResult {
  collector: string;
  title: string;
  bodyLength: number;
  draft: EventDraft;
  status: IngestStatus;
  dedupe: DedupeDecision;
  notes: string[];
  /** 与去重使用的指纹一致，落地时直接传给 sink，避免两处算法分叉 */
  fingerprint: string;
}

export async function runPipeline(
  record: RawRecord,
  deps: IngestDeps = {}
): Promise<IngestResult> {
  const { title, body } = normalizeText({ title: record.title, content: record.content });
  const anchor = anchorOf(record);
  const notes: string[] = [];

  if (record.missing.length > 0) {
    notes.push(`原始记录缺字段：${record.missing.join(", ")}`);
  }

  const rules = extractByRules(body, anchor);

  let llmFacts = null;
  const extractor = deps.extractor ?? noopExtractor;
  try {
    llmFacts = await extractor({ title, body, anchor });
  } catch (error) {
    notes.push(`模型抽取失败，退化为纯规则：${error instanceof Error ? error.message : "未知错误"}`);
  }

  const { draft, conflicts } = crossCheck({
    title,
    body,
    anchor,
    rules,
    llm: llmFacts,
    collector: record.collector,
    sourceUrl: record.url,
    department: record.department,
    structured: record.structured,
  });

  const dedupeResult = dedupe(
    {
      collector: record.collector,
      url: record.url,
      title,
      body,
      kind: draft.kind,
      occurAt: draft.occurAt,
      externalId: record.externalId,
    },
    deps.pool ?? []
  );

  if (draft.uncertain) notes.push("原文含“另行通知/待定”等表述，时间可能变化");

  const status: IngestStatus =
    draft.occurAt && draft.confidence >= 0.6 && !draft.uncertain ? "ready" : "pending_review";

  if (status === "pending_review") {
    if (!draft.occurAt) notes.push("缺少可核实的日期，转人工确认");
    else if (draft.confidence < 0.6) notes.push(`置信度 ${draft.confidence.toFixed(2)} 低于阈值 0.6`);
  }

  return {
    collector: record.collector,
    title: draft.title,
    bodyLength: body.length,
    draft,
    status,
    dedupe: dedupeResult,
    notes: [...notes, ...conflicts],
    fingerprint: contentFingerprint(`${title}\n${body}`),
  };
}
