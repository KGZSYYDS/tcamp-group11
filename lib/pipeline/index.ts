/**
 * 数据处理的公共入口。
 *
 * 外部（页面、脚本、以后的服务端任务）只从这里 import，
 * 不要直接引用 lib/pipeline/* 下的具体文件——那些是实现细节，随时可能重排。
 *
 * 典型用法：
 *   import { runPipeline } from "@/lib/pipeline";
 *   const result = await runPipeline(record, { extractor, pool });
 */

export { runPipeline } from "./ingest";
export type { IngestDeps, IngestResult } from "./ingest";

export type { EventDraft, IngestStatus } from "./draft";
export { isDraftUsable } from "./draft";

export type { EventSink, SaveMeta, SaveResult } from "./sink";
export { MemorySink, toPoolItem } from "./sink";

export { normalizeText, canonicalUrl } from "./normalize";

export type { DedupeCandidate, DedupeDecision, DedupePoolItem } from "./dedupe";
