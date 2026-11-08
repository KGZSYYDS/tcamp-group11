/**
 * 命令行：把一份原始数据跑成结构化草稿。
 *
 * 用途一：采集方自查——"我给的东西会被解析成什么、缺什么"，不用理解内部代码。
 * 用途二：本地排查——某条通知日期抽错了，直接看它走完整条管道的结果。
 *
 * 用法：
 *   node scripts/ingest.mjs fixtures/inbox/gwt-board/2026-11-08.json
 *   node scripts/ingest.mjs 我的数据.json --collector wecom-paste
 *   node scripts/ingest.mjs 我的数据.json --json  > result.json
 */

import { readFileSync } from "fs";
import { basename, dirname, resolve } from "path";

import { adapt } from "../lib/ingest/adapters";
import { auditCapabilities, summarizeAudit } from "../lib/ingest/capabilities";
import type { RawRecord } from "../lib/ingest/types";
import { runPipeline } from "../lib/pipeline/ingest";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function positional(): string | undefined {
  return process.argv.slice(2).find((a) => !a.startsWith("--") && !isFlagValue(a));
}

function isFlagValue(value: string): boolean {
  const index = process.argv.indexOf(value);
  if (index <= 0) return false;
  const prev = process.argv[index - 1];
  return prev === "--collector" || prev === "--anchor";
}

/** 采集器标识默认取上一级目录名：fixtures/inbox/gwt-board/x.json → gwt-board */
function inferCollector(file: string): string {
  return basename(dirname(resolve(file)));
}

function formatDraft(index: number, record: RawRecord, result: Awaited<ReturnType<typeof runPipeline>>): void {
  const d = result.draft;
  const when = d.occurAt ? d.occurAt.replace("+08:00", "").replace("T", " ") : "（无日期）";
  const allDayNote = d.occurAt && d.allDay ? "（全天）" : "";
  const deadline = d.actionDeadline
    ? d.actionDeadline.slice(5, 10).replace("-", "/")
    : "—";
  const confidence = d.confidence.toFixed(2);

  console.log(`\n[${index}] ${d.title}`);
  console.log(
    `    类别 ${d.kind} | 发生 ${when}${allDayNote} | 报名截止 ${deadline} | 可见 ${d.visibility} | 置信度 ${confidence} | ${result.status}`
  );
  if (d.evidence.length) console.log(`    依据：${d.evidence.join(" ／ ")}`);
  if (d.conflicts.length) console.log(`    冲突：${d.conflicts.join("；")}`);
  if (record.missing.length) console.log(`    原始缺字段：${record.missing.join(", ")}`);

  // 缺字段、缺日期、冲突都已单独展示过，这里跳过避免重复
  const notes = result.notes.filter(
    (n) =>
      !n.startsWith("原始记录缺字段") &&
      !n.startsWith("缺少可核实的日期") &&
      !d.conflicts.includes(n)
  );
  for (const note of notes.slice(0, 3)) console.log(`    提示：${note}`);
  if (result.dedupe.action !== "insert") {
    console.log(`    去重：${result.dedupe.action}（${result.dedupe.reason}）`);
  }
}

async function main(): Promise<void> {
  const file = positional();
  if (!file) {
    console.error("用法：node scripts/ingest.mjs <文件.json> [--collector 名字] [--json]");
    process.exit(1);
  }

  const path = resolve(file);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    console.error(`读取失败：${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  const collector = flag("--collector") || inferCollector(path);
  const receivedAt = flag("--anchor") || new Date().toISOString();

  const records = adapt({ collector, receivedAt, payload });
  const audit = auditCapabilities(records);

  const results = [];
  for (const record of records) {
    results.push({ record, result: await runPipeline(record) });
  }

  if (has("--json")) {
    console.log(JSON.stringify(results.map((r) => r.result), null, 2));
    return;
  }

  console.log(`文件：${file}`);
  console.log(`采集器：${collector}    记录数：${records.length}`);
  console.log(`能力审计：${summarizeAudit(audit)}`);

  if (audit.blocking.length) {
    for (const item of audit.blocking) {
      console.log(`  · 缺「${item.label}」${item.missingCount} 条 —— ${item.hint}`);
    }
  }

  results.forEach((item, i) => formatDraft(i + 1, item.record, item.result));

  const ready = results.filter((r) => r.result.status === "ready").length;
  console.log(
    `\n合计 ${results.length} 条：${ready} 条可直接入库，${results.length - ready} 条需人工确认。`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
