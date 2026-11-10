/**
 * 输入层的公共入口。
 *
 * 外部只需要这里：把"采集方给的任意东西"转成内部记录，并检查它是否具备入库条件。
 *
 * 典型用法：
 *   import { adapt, auditCapabilities } from "@/lib/ingest";
 *   const records = adapt({ collector: "gwt-board", receivedAt, payload });
 *   const audit = auditCapabilities(records);
 */

export { adapt, isFallback, listRegistered, registerAdapter } from "./adapters";

export { auditCapabilities, summarizeAudit } from "./capabilities";
export type { AuditResult, CapabilityKey, CapabilityReport } from "./capabilities";

export type {
  Adapter,
  IngestEnvelope,
  MissingField,
  RawRecord,
  RawRecordStructured,
} from "./types";
export { MISSING_LABEL } from "./types";

export { anchorOf, makeRawRecord } from "./record";
