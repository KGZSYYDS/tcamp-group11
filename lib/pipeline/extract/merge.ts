import type { Audience, EventKind } from "../../types";
import type { RawRecordStructured } from "../../ingest/types";
import { getVisibilityFromAudience } from "../../visibility";
import type { EventDraft } from "../draft";
import { dayDiff, formatIso, shanghaiParts } from "../time";
import { verifyAudienceValue, verifyDateEvidence, verifyTitle } from "./evidence";
import type { LlmFacts } from "./llm";
import type { RuleFacts } from "./rules";

/**
 * 交叉校验：把规则通道与模型通道对齐，产出草稿 + 置信度 + 冲突清单。
 *
 * 三条不可让步的规矩：
 * 1. 标题永远用原文标题，模型改写的标题不采信（契约要求原文不可改写）
 * 2. 任何日期必须通过 evidence 校验，否则丢弃并回退到规则结果
 * 3. 归属判不准就往窄里落：没有原文依据的学院/班级一律不写，最终落到 campus
 */

const LEVEL_MAP: Record<string, string> = {
  undergraduate: "undergraduate",
  postgraduate: "postgraduate",
  doctoral: "doctoral",
  本科: "undergraduate",
  本科生: "undergraduate",
  硕士: "postgraduate",
  硕士生: "postgraduate",
  研究生: "postgraduate",
  博士: "doctoral",
  博士生: "doctoral",
};

function normalizeDateString(value?: string | null): string | null {
  if (!value) return null;
  const m = /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/.exec(value);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function withTime(dateIso: string, time?: string | null): string {
  const p = shanghaiParts(dateIso);
  if (!p) return dateIso;
  const tm = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(time || "");
  const hh = tm ? Number(tm[1]) : 0;
  const mm = tm ? Number(tm[2]) : 0;
  return formatIso(p.y, p.m, p.d, hh, mm);
}

function normalizeLevel(value?: string | null): string | undefined {
  if (!value) return undefined;
  return LEVEL_MAP[value.trim()];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export interface CrossCheckInput {
  title: string;
  body: string;
  anchor: string;
  rules: RuleFacts;
  llm: LlmFacts | null;
  collector: string;
  sourceUrl: string;
  department?: string;
  /** 平台自带的结构化时间，优先于文本抽取 */
  structured?: RawRecordStructured;
}

export interface CrossCheckResult {
  draft: EventDraft;
  confidence: number;
  conflicts: string[];
  evidence: string[];
}

export function crossCheck(input: CrossCheckInput): CrossCheckResult {
  const { title, body, anchor, rules, llm, collector, sourceUrl, department, structured } = input;
  const conflicts: string[] = [];
  const evidence: string[] = [];
  let confidence = 0.45;

  /* ---------- 日期 ---------- */
  let occurAt: string | null = null;
  let allDay = true;

  // 平台自带结构化时间：最可靠，优先采用，不参与文本证据校验
  if (structured?.occurAt) {
    occurAt = structured.occurAt;
    allDay = /T00:00:00/.test(structured.occurAt);
    confidence += 0.4;
    evidence.push("平台结构化时间");
  }

  const llmDate = normalizeDateString(llm?.date);
  if (!occurAt && llmDate) {
    const check = verifyDateEvidence(llmDate, body, anchor);
    if (check.ok) {
      occurAt = withTime(llmDate, llm?.time);
      allDay = !llm?.time;
      confidence += check.method === "literal" ? 0.3 : 0.22;
      if (check.snippet) evidence.push(check.snippet);
    } else {
      conflicts.push("模型给出的日期在原文中找不到依据，已丢弃");
    }
  }

  if (!occurAt && rules.primary) {
    occurAt = rules.primary.iso;
    allDay = !rules.primary.hasTime;
    confidence += 0.12;
    evidence.push(rules.primary.raw);
  }

  if (
    !structured?.occurAt &&
    llmDate &&
    rules.primary &&
    dayDiff(`${llmDate}T00:00:00+08:00`, rules.primary.iso) !== 0
  ) {
    const gap = Math.abs(dayDiff(`${llmDate}T00:00:00+08:00`, rules.primary.iso));
    if (gap > 1) conflicts.push(`规则与模型日期相差 ${gap} 天`);
  }

  if (!occurAt) conflicts.push("未找到可核实的日期");

  /* ---------- 结束时间 ---------- */
  let endAt: string | null = null;
  if (structured?.endAt && occurAt && dayDiff(occurAt, structured.endAt) > 0) {
    endAt = structured.endAt;
  }

  const llmEnd = normalizeDateString(llm?.endDate);
  if (!endAt && llmEnd && occurAt) {
    const check = verifyDateEvidence(llmEnd, body, anchor);
    if (check.ok && dayDiff(occurAt, `${llmEnd}T00:00:00+08:00`) > 0) {
      endAt = withTime(llmEnd, null);
      if (check.snippet) evidence.push(check.snippet);
    } else if (!check.ok) {
      conflicts.push("结束日期缺少原文依据，已忽略");
    }
  }

  /* ---------- 类别 ---------- */
  let kind: EventKind = "other";
  const llmKind = llm?.kind ?? undefined;
  const structuredKind = structured?.kind as EventKind | undefined;

  if (structuredKind && ["exam", "pe", "activity", "other"].includes(structuredKind)) {
    kind = structuredKind;
    confidence += 0.1;
  } else if (rules.kindHint && llmKind && rules.kindHint !== llmKind) {
    conflicts.push(`类别判断不一致（规则=${rules.kindHint}，模型=${llmKind}），以规则为准`);
    kind = rules.kindHint;
  } else if (rules.kindHint) {
    kind = rules.kindHint;
    confidence += 0.06;
  } else if (llmKind) {
    kind = llmKind;
    confidence += 0.03;
  }

  /* ---------- 受众 ---------- */
  const audience: Audience = {};

  const llmAudience = llm?.audience || {};
  const llmCollege = llmAudience.college || undefined;
  if (llmCollege) {
    if (verifyAudienceValue(llmCollege, body)) audience.college = llmCollege;
    else conflicts.push("模型给出的学院在原文中没有出现，已忽略");
  }
  if (rules.audience.college && !audience.college) audience.college = rules.audience.college;

  const llmClass = llmAudience.class || undefined;
  if (llmClass) {
    if (verifyAudienceValue(llmClass, body)) audience.class = llmClass;
    else conflicts.push("模型给出的班级在原文中没有出现，已忽略");
  }

  const gradeValue = llmAudience.grade ?? rules.audience.grade;
  if (gradeValue !== undefined && gradeValue !== null && gradeValue !== "") {
    const text = String(gradeValue).replace(/[^\d]/g, "");
    if (text && body.includes(text)) audience.grade = Number(text);
  }

  const level = normalizeLevel(llmAudience.level) || rules.audience.level;
  if (level) audience.level = level;

  if (llmAudience.course && verifyAudienceValue(String(llmAudience.course), body)) {
    audience.course = String(llmAudience.course);
  }

  /* ---------- 行动截止 ---------- */
  let actionDeadline: string | null = null;
  if (structured?.actionDeadline) actionDeadline = structured.actionDeadline;

  const llmDeadline = normalizeDateString(llm?.actionDeadline);
  if (!actionDeadline && llmDeadline) {
    const check = verifyDateEvidence(llmDeadline, body, anchor);
    if (check.ok) {
      actionDeadline = withTime(llmDeadline, null);
      confidence += 0.05;
      if (check.snippet) evidence.push(check.snippet);
    } else {
      conflicts.push("模型给出的截止时间缺少原文依据，已忽略");
    }
  }
  if (!actionDeadline && rules.actionDeadline) {
    actionDeadline = rules.actionDeadline.iso;
    evidence.push(rules.actionDeadline.raw);
  }

  /* ---------- 其他字段 ---------- */
  const location =
    llm?.location && verifyAudienceValue(String(llm.location), body)
      ? String(llm.location)
      : null;

  const link = rules.links[0] || (llm?.link && /^https?:\/\//.test(llm.link) ? llm.link : null);

  const titleCheck = verifyTitle(title, body);
  if (!titleCheck.ok && title.length > 0) {
    conflicts.push("标题与正文匹配度偏低，请核对原文");
  } else {
    confidence += 0.05;
  }

  /* ---------- 汇总 ---------- */
  confidence = clamp(confidence - conflicts.length * 0.05, 0.05, 0.95);

  const visibility = getVisibilityFromAudience(audience);

  const draft: EventDraft = {
    title,
    kind,
    occurAt,
    endAt,
    allDay: occurAt ? allDay : true,
    actionDeadline,
    location,
    link,
    audience,
    visibility,
    sourceUrl,
    collector,
    department,
    confidence,
    evidence: Array.from(new Set(evidence.filter(Boolean))).slice(0, 6),
    uncertain: rules.uncertain,
    conflicts,
  };

  return { draft, confidence, conflicts, evidence: draft.evidence };
}
