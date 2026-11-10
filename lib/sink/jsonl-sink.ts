import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { DedupeCandidate, DedupePoolItem } from "../pipeline/dedupe";
import type { EventDraft, IngestStatus } from "../pipeline/draft";
import type { EventSink, SaveMeta, SaveResult } from "../pipeline/sink";
import { toPoolItem } from "../pipeline/sink";

/**
 * 本地 JSONL 落地。
 *
 * 放在 lib/sink/ 而不是 lib/pipeline/，因为它依赖 node:fs，
 * 不能被浏览器端代码 import。默认写 data/drafts/（已在 .gitignore）。
 *
 * 只追加、不改写：便于回溯"某条草稿当时是什么样"。
 */

interface StoredLine {
  id: string;
  savedAt: string;
  status: IngestStatus;
  fingerprint: string;
  externalId?: string;
  notes?: string[];
  draft: EventDraft;
}

interface PendingLine {
  savedAt: string;
  notes: string[];
  draft: EventDraft;
}

export interface JsonlSinkOptions {
  /** 默认 <项目根>/data/drafts */
  dir?: string;
}

export class JsonlSink implements EventSink {
  private readonly dir: string;

  constructor(options: JsonlSinkOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), "data", "drafts");
  }

  async findExisting(_candidate: DedupeCandidate): Promise<DedupePoolItem[]> {
    return this.readAll().map((line) => toPoolItem(line.id, line.draft, line));
  }

  async save(draft: EventDraft, meta: SaveMeta): Promise<SaveResult> {
    const existing = this.readAll().find((line) => line.fingerprint === meta.fingerprint);
    if (existing) return { id: existing.id, created: false };

    const line: StoredLine = {
      id: `local-${randomUUID().slice(0, 8)}`,
      savedAt: new Date().toISOString(),
      status: meta.status,
      fingerprint: meta.fingerprint,
      externalId: meta.externalId,
      notes: meta.notes,
      draft,
    };
    this.append("events.jsonl", line);
    return { id: line.id, created: true };
  }

  async markPendingReview(draft: EventDraft, notes: string[]): Promise<void> {
    const line: PendingLine = { savedAt: new Date().toISOString(), notes, draft };
    this.append("pending.jsonl", line);
  }

  /** 测试与排查用 */
  list(): StoredLine[] {
    return this.readAll();
  }

  /** 人工确认队列 */
  pendingList(): PendingLine[] {
    return this.readFile("pending.jsonl") as PendingLine[];
  }

  private append(file: string, line: unknown): void {
    this.ensureDir();
    appendFileSync(join(this.dir, file), `${JSON.stringify(line)}\n`, "utf-8");
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private readAll(): StoredLine[] {
    return this.readFile("events.jsonl") as StoredLine[];
  }

  /** 单文件读取；损坏行直接跳过，不让一条脏数据拖垮整批 */
  private readFile(file: string): unknown[] {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf-8");
    const out: unknown[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return out;
  }

  /** 目录里有哪些文件，便于排查 */
  files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".jsonl"));
  }
}
