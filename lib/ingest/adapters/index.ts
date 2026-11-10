import type { Adapter, IngestEnvelope, RawRecord } from "../types";
import { genericJsonAdapter } from "./generic-json";
import { lmsTodosAdapter } from "./lms-todos";

/**
 * 适配器注册表。
 *
 * 一个采集器一个适配器；没注册过的采集器走通用 JSON 兜底。
 * 对方改格式时只影响一个文件，管道与 UI 不受影响。
 */

const registry = new Map<string, Adapter>();

export function registerAdapter(collector: string, adapter: Adapter): void {
  registry.set(collector, adapter);
}

export function listRegistered(): string[] {
  return Array.from(registry.keys());
}

export function adapt(envelope: IngestEnvelope): RawRecord[] {
  const adapter = registry.get(envelope.collector) ?? genericJsonAdapter;
  return adapter(envelope.payload, {
    collector: envelope.collector,
    receivedAt: envelope.receivedAt,
  });
}

/** 是否走了兜底适配器——用于日志与能力审计 */
export function isFallback(collector: string): boolean {
  return !registry.has(collector);
}

registerAdapter("lms-todos", lmsTodosAdapter);
