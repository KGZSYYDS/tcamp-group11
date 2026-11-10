import type { DedupeCandidate, DedupePoolItem } from "./dedupe";
import type { EventDraft, IngestStatus } from "./draft";

/**
 * 落地接口。
 *
 * 管道只负责"把原文变成草稿"，不负责"存到哪"。这里定义唯一的出口，
 * 于是：接云端写 CloudSink、本地调试写 JsonlSink、测试用 MemorySink，
 * **管道与调用方都不用改**。
 *
 * 注意：本文件必须保持同构（浏览器也能 import），所以不能出现 fs / path。
 */

export interface SaveMeta {
  fingerprint: string;
  status: IngestStatus;
  /** 需要人工确认时带上原因 */
  notes?: string[];
  /** 平台稳定 id，有则可用于精确去重 */
  externalId?: string;
}

export interface SaveResult {
  id: string;
  /** 已经存在时为 false，便于调用方统计新增量 */
  created: boolean;
}

export interface EventSink {
  /** 返回用于去重的候选池；具体怎么缩小范围由实现决定 */
  findExisting(candidate: DedupeCandidate): Promise<DedupePoolItem[]>;
  save(draft: EventDraft, meta: SaveMeta): Promise<SaveResult>;
  /** 低置信度/含不确定表述的草稿进人工确认队列 */
  markPendingReview(draft: EventDraft, notes: string[]): Promise<void>;
}

export function toPoolItem(
  id: string,
  draft: EventDraft,
  meta: SaveMeta
): DedupePoolItem {
  return {
    id,
    collector: draft.collector,
    url: draft.sourceUrl || undefined,
    externalId: meta.externalId,
    title: draft.title,
    fingerprint: meta.fingerprint,
    kind: draft.kind,
    occurAt: draft.occurAt,
  };
}

interface MemoryEntry {
  id: string;
  seq: number;
  draft: EventDraft;
  meta: SaveMeta;
  status: IngestStatus;
}

/**
 * 内存实现：测试、本地演示、以及"先把流程跑起来"时用。
 * 进程结束即丢失，不做任何持久化。
 */
export class MemorySink implements EventSink {
  private readonly entries: MemoryEntry[] = [];
  private readonly pending: Array<{ draft: EventDraft; notes: string[] }> = [];
  private seq = 0;

  async findExisting(_candidate: DedupeCandidate): Promise<DedupePoolItem[]> {
    return this.entries.map((e) => toPoolItem(e.id, e.draft, e.meta));
  }

  async save(draft: EventDraft, meta: SaveMeta): Promise<SaveResult> {
    const existing = this.entries.find((e) => e.meta.fingerprint === meta.fingerprint);
    if (existing) return { id: existing.id, created: false };

    this.seq += 1;
    const id = `mem-${this.seq}`;
    this.entries.push({ id, seq: this.seq, draft, meta, status: meta.status });
    return { id, created: true };
  }

  async markPendingReview(draft: EventDraft, notes: string[]): Promise<void> {
    this.pending.push({ draft, notes });
  }

  /** 测试与调试用 */
  list(): MemoryEntry[] {
    return [...this.entries];
  }

  pendingList(): Array<{ draft: EventDraft; notes: string[] }> {
    return [...this.pending];
  }
}
