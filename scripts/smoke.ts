/**
 * B0 自检脚本：跑通「适配器 → 能力审计 → 管道 → 可见性判定」全链路。
 *
 * 运行： node .tmp-check/scripts/smoke.js   （先 tsc 编译，见 package.json 说明）
 * 不连数据库、不调真实模型，纯离线。
 */

import { readFileSync, rmSync } from "fs";
import { join } from "path";

import { adapt } from "../lib/ingest/adapters";
import { auditCapabilities, summarizeAudit } from "../lib/ingest/capabilities";
import type { IngestEnvelope } from "../lib/ingest/types";
import { anchorOf } from "../lib/ingest/record";
import type { DedupePoolItem } from "../lib/pipeline/dedupe";
import { dedupe } from "../lib/pipeline/dedupe";
import type { ExtractorFn } from "../lib/pipeline/extract/llm";
import { runPipeline } from "../lib/pipeline/ingest";
import { canonicalUrl } from "../lib/pipeline/normalize";
import { MemorySink } from "../lib/pipeline/sink";
import { JsonlSink } from "../lib/sink/jsonl-sink";
import { isVisible, pickVisibility } from "../lib/visibility";
import type { VisibilitySubject } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean | undefined, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : `  →  ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function fixture(...parts: string[]): unknown {
  const file = join(process.cwd(), "fixtures", "inbox", ...parts);
  return JSON.parse(readFileSync(file, "utf-8"));
}

function envelope(collector: string, receivedAt: string, payload: unknown): IngestEnvelope {
  return { collector, receivedAt, payload };
}

/* ---------- 观看者 ---------- */

const viewerA: Viewer = {
  kind: "user",
  uid: "u1",
  role: "student",
  verified: true,
  studentNo: "2024150106",
  college: "计算机与软件学院",
  major: "计算机科学与技术",
  grade: "2024",
  class: "计科1班",
  level: "undergraduate",
  courses: ["数据结构", "计算机导论"],
};

const viewerB: Viewer = {
  kind: "user",
  uid: "u2",
  role: "student",
  verified: true,
  studentNo: "2023150001",
  college: "建筑与城市规划学院",
  major: "建筑学",
  grade: "2023",
  class: "建筑2班",
  level: "postgraduate",
  courses: ["建筑设计"],
};

const anon: Viewer = { kind: "anon" };

async function main(): Promise<void> {
  /* ---------- 1. 适配器 + 能力审计 ---------- */

  section("1. 适配器与能力审计");
  const gwtPayload = fixture("gwt-board", "2026-11-08.json");
  const gwtRecords = adapt(envelope("gwt-board", "2026-11-08T11:00:00+08:00", gwtPayload));
  check("公文通嵌套结构解析出 2 条", gwtRecords.length === 2, gwtRecords.length);

  const gwtAudit = auditCapabilities(gwtRecords);
  console.log(`  ${summarizeAudit(gwtAudit)}`);
  check("公文通记录 5 项能力齐备", gwtAudit.ready, gwtAudit.blocking.map((b) => b.key));

  const lmsPayload = fixture("lms-todos", "2026-11-08.json");
  const lmsRecords = adapt(envelope("lms-todos", "2026-11-08T11:05:00+08:00", lmsPayload));
  check("畅课待办解析出 3 条", lmsRecords.length === 3, lmsRecords.length);
  check("待办带平台稳定 id", lmsRecords.every((r) => Boolean(r.externalId)));
  const lmsAudit = auditCapabilities(lmsRecords);
  console.log(`  ${summarizeAudit(lmsAudit)}`);

  const pastePayload = fixture("wecom-paste", "2026-11-08.json");
  const pasteRecords = adapt(envelope("wecom-paste", "2026-11-08T11:10:00+08:00", pastePayload));
  check("群消息粘贴解析出 2 条", pasteRecords.length === 2, pasteRecords.length);
  const pasteAudit = auditCapabilities(pasteRecords);
  console.log(`  ${summarizeAudit(pasteAudit)}`);
  check("审计指出粘贴内容缺原文链接", pasteAudit.blocking.some((b) => b.key === "traceable"));

  /* ---------- 2. 管道：公文通 ---------- */

  section("2. 管道输出（公文通）");
  const exam = await runPipeline(gwtRecords[0]);
  console.log(
    `  ${exam.title} | ${exam.draft.occurAt} | ${exam.draft.kind} | ${exam.draft.visibility} | ${exam.draft.confidence.toFixed(
      2
    )} | ${exam.status}`
  );
  check("考试通知解析出开始日期 2026-12-28", exam.draft.occurAt?.startsWith("2026-12-28"));
  check("报名截止识别为 2026-12-05", exam.draft.actionDeadline?.startsWith("2026-12-05"), exam.draft.actionDeadline);
  check("类别判定为 exam", exam.draft.kind === "exam", exam.draft.kind);
  check("未限定学院 → campus", exam.draft.visibility === "campus", exam.draft.visibility);
  check("状态为 ready", exam.status === "ready", exam.status);
  check("日期带原文证据", exam.draft.evidence.length > 0, exam.draft.evidence);

  const pe = await runPipeline(gwtRecords[1]);
  check("体测通知类别为 pe", pe.draft.kind === "pe", pe.draft.kind);
  check("识别出本科生受众", pe.draft.audience.level === "undergraduate", pe.draft.audience);
  check("体测日期 2026-11-21", pe.draft.occurAt?.startsWith("2026-11-21"), pe.draft.occurAt);

  /* ---------- 3. 管道：畅课待办 ---------- */

  section("3. 管道输出（畅课待办）");
  const todo = await runPipeline(lmsRecords[0]);
  console.log(
    `  ${todo.title} | ${todo.draft.occurAt} | ${todo.draft.visibility} | ${todo.draft.confidence.toFixed(2)} | ${todo.status}`
  );
  check("结构化截止时间直接采用", todo.draft.occurAt === "2026-11-15T23:59:00+08:00", todo.draft.occurAt);
  check("有结构化时间时不受空正文影响", todo.status === "ready", todo.status);
  check("证据标记为平台结构化时间", todo.draft.evidence.includes("平台结构化时间"));

  const pool: DedupePoolItem[] = [
    { id: "e1", collector: "lms-todos", externalId: "lms-todo:8812301", title: "实验4 Python 算法设计" },
  ];
  const again = await runPipeline(lmsRecords[0], { pool });
  check("同一平台 id 再次入库判为 skip", again.dedupe.action === "skip", again.dedupe);

  /* ---------- 4. 管道：相对时间与待确认 ---------- */

  section("4. 相对时间与人工确认");
  const adjust = await runPipeline(pasteRecords[0]);
  console.log(
    `  ${adjust.title} | ${adjust.draft.occurAt} | ${adjust.draft.confidence.toFixed(2)} | ${adjust.status}`
  );
  check("“下周三”按发布时间换算为 2026-11-11", adjust.draft.occurAt?.startsWith("2026-11-11"), adjust.draft.occurAt);
  check("下午3点识别为 15:00", adjust.draft.occurAt?.includes("T15:00"), adjust.draft.occurAt);
  check("非全天事件", adjust.draft.allDay === false);

  const noDate = await runPipeline(pasteRecords[1]);
  check("无日期 + “另行通知” → 待确认", noDate.status === "pending_review", noDate.status);

  /* ---------- 5. 幻觉抑制 ---------- */

  section("5. 模型幻觉抑制");
  const liar: ExtractorFn = async () => ({
    date: "2026-12-31",
    title: "模型自己改写的标题",
    kind: "activity",
    selfConfidence: 0.99,
  });
  const lied = await runPipeline(gwtRecords[0], { extractor: liar });
  check(
    "无原文依据的日期被丢弃",
    lied.draft.occurAt?.startsWith("2026-12-28"),
    lied.draft.occurAt
  );
  check(
    "冲突清单记录了丢弃原因",
    lied.notes.some((n) => n.includes("找不到依据")),
    lied.notes
  );
  check("标题仍用原文，不被改写", lied.draft.title === gwtRecords[0].title, lied.draft.title);

  const honest: ExtractorFn = async () => ({
    date: "2026-12-28",
    time: "09:00",
    kind: "exam",
    actionDeadline: "2026-12-05",
  });
  const trusted = await runPipeline(gwtRecords[0], { extractor: honest });
  check("有原文依据的日期被采用", trusted.draft.occurAt === "2026-12-28T09:00:00+08:00", trusted.draft.occurAt);
  check("带时刻时不再是全天事件", trusted.draft.allDay === false);
  check("置信度高于纯规则结果", trusted.draft.confidence > exam.draft.confidence, [
    trusted.draft.confidence,
    exam.draft.confidence,
  ]);

  /* ---------- 6. 可见性矩阵 ---------- */

  section("6. 可见性判定（越权必须为 false）");
  const visibilityCases: Array<{
    name: string;
    subject: VisibilitySubject;
    expect: [boolean, boolean, boolean]; // A, B, anon
  }> = [
    { name: "public", subject: { visibility: "public" }, expect: [true, true, true] },
    { name: "campus", subject: { visibility: "campus" }, expect: [true, true, false] },
    {
      name: "college(计软)",
      subject: { visibility: "college", audience: { college: "计算机与软件学院" } },
      expect: [true, false, false],
    },
    {
      name: "major(计科)",
      subject: { visibility: "major", audience: { major: "计算机科学与技术" } },
      expect: [true, false, false],
    },
    { name: "grade(2024)", subject: { visibility: "grade", audience: { grade: 2024 } }, expect: [true, false, false] },
    { name: "class(计科1班)", subject: { visibility: "class", audience: { class: "计科1班" } }, expect: [true, false, false] },
    { name: "course(数据结构)", subject: { visibility: "course", audience: { course: "数据结构" } }, expect: [true, false, false] },
    { name: "private(他人)", subject: { visibility: "private", ownerId: "u2" }, expect: [false, true, false] },
    { name: "private(自己)", subject: { visibility: "private", ownerId: "u1" }, expect: [true, false, false] },
    { name: "未知 visibility", subject: { visibility: "mystery" }, expect: [false, false, false] },
    { name: "legacy school", subject: { scope: "school" }, expect: [true, true, false] },
    { name: "legacy personal(自己)", subject: { scope: "personal", ownerId: "u1" }, expect: [true, false, false] },
    { name: "legacy undergraduate", subject: { scope: "undergraduate" }, expect: [true, false, false] },
    {
      name: "legacy college",
      subject: { scope: "college", college: "计算机与软件学院" },
      expect: [true, false, false],
    },
    { name: "未知 legacy scope", subject: { scope: "whatever" }, expect: [false, false, false] },
  ];

  for (const item of visibilityCases) {
    const got: [boolean, boolean, boolean] = [
      isVisible(item.subject, viewerA),
      isVisible(item.subject, viewerB),
      isVisible(item.subject, anon),
    ];
    check(
      `${item.name} → ${got.join("/")}`,
      got[0] === item.expect[0] && got[1] === item.expect[1] && got[2] === item.expect[2],
      { expect: item.expect, got }
    );
  }

  /* ---------- 7. 归一化与去重 ---------- */

  section("7. 归一化与去重");
  check(
    "URL 去掉 utm 与锚点",
    canonicalUrl("https://www1.szu.edu.cn/board/view.asp?id=1&utm_source=x#top") ===
      "https://www1.szu.edu.cn/board/view.asp?id=1",
    canonicalUrl("https://www1.szu.edu.cn/board/view.asp?id=1&utm_source=x#top")
  );
  check(
    "参数顺序归一",
    canonicalUrl("https://a.cn/p?b=2&a=1") === canonicalUrl("https://a.cn/p?a=1&b=2")
  );

  const semantic = dedupe(
    {
      collector: "wecom-paste",
      url: "",
      title: "关于期末考试安排的通知（更新）",
      body: "期末考试安排有所调整，请查看最新通知",
      kind: "exam",
      occurAt: "2026-12-28T00:00:00+08:00",
    },
    [
      {
        id: "e9",
        collector: "gwt-board",
        title: "关于期末考试安排的通知",
        kind: "exam",
        occurAt: "2026-12-28T00:00:00+08:00",
      },
    ]
  );
  check("标题相似 + 同日 → merge", semantic.action === "merge", semantic);

  const fresh = dedupe(
    {
      collector: "wecom-paste",
      url: "",
      title: "社团招新",
      body: "周五在荔园摆摊",
      kind: "activity",
      occurAt: "2026-11-13T00:00:00+08:00",
    },
    []
  );
  check("空池 → insert", fresh.action === "insert", fresh);

  /* ---------- 8. 投影：legacy 双读 ---------- */

  section("8. 旧数据双读");
  const legacy = pickVisibility({ scope: "college", college: "计算机与软件学院" });
  check("legacy scope 映射", legacy.visibility === "college" && legacy.audience.college === "计算机与软件学院", legacy);
  check("来源标记为 legacy", legacy.from === "legacy");

  /* ---------- 9. 落地接口 ---------- */

  section("9. 落地接口");
  const memorySink = new MemorySink();
  const firstSave = await memorySink.save(adjust.draft, {
    fingerprint: adjust.fingerprint,
    status: adjust.status,
  });
  check("MemorySink 首次写入 created=true", firstSave.created === true, firstSave);

  const secondSave = await memorySink.save(adjust.draft, {
    fingerprint: adjust.fingerprint,
    status: adjust.status,
  });
  check(
    "同一指纹重复写入不新增",
    secondSave.created === false && secondSave.id === firstSave.id,
    secondSave
  );

  const sinkPool = await memorySink.findExisting({
    collector: "wecom-paste",
    url: "",
    title: adjust.title,
    body: "",
    kind: adjust.draft.kind,
    occurAt: adjust.draft.occurAt,
  });
  check("findExisting 返回可去重的候选池", sinkPool.length === 1, sinkPool);

  const replayed = await runPipeline(pasteRecords[0], { pool: sinkPool });
  check("同一记录再次入库判为重复", replayed.dedupe.action === "skip", replayed.dedupe);

  const draftDir = join(process.cwd(), "data", ".smoke-drafts");
  rmSync(draftDir, { recursive: true, force: true });
  const jsonlSink = new JsonlSink({ dir: draftDir });
  const writeA = await jsonlSink.save(adjust.draft, {
    fingerprint: adjust.fingerprint,
    status: adjust.status,
  });
  const writeB = await jsonlSink.save(adjust.draft, {
    fingerprint: adjust.fingerprint,
    status: adjust.status,
  });
  check(
    "JsonlSink 只落一条，重复写入被拦",
    writeA.created === true && writeB.created === false && jsonlSink.list().length === 1,
    jsonlSink.list().length
  );
  check("落盘后能读回草稿字段", jsonlSink.list()[0]?.draft.title === adjust.draft.title);

  await jsonlSink.markPendingReview(noDate.draft, noDate.notes);
  check("待确认队列可写入", jsonlSink.pendingList().length === 1);
  rmSync(draftDir, { recursive: true, force: true });

  /* ---------- 汇总 ---------- */

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
  if (failures > 0) process.exitCode = 1;

  // 顺手验证时间基准不会被"当前时间"污染
  const anchor = anchorOf(gwtRecords[0]);
  console.log(`  时间基准：${anchor}（发布时间，而非当前时间）`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
