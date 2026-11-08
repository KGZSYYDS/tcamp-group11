import type { Audience, EventKind } from "../../types";
import {
  RELATIVE_PHRASES,
  combineDateTime,
  formatIso,
  inferYear,
  parseTimeOfDay,
  resolveRelative,
} from "../time";
/**
 * 规则通道：只做"有把握的抽取"，抽不到就留空，不猜。
 * 它的另一个作用是给 LLM 当"证据基准"——LLM 给的日期要能在这里或原文中找到落点。
 */

export interface DateHit {
  /** 完整 ISO（含时刻，可能为 00:00） */
  iso: string;
  /** 日期部分，便于按天比较 */
  dateIso: string;
  /** 命中的原文片段 */
  raw: string;
  /** 在归一化正文中的起始位置 */
  index: number;
  source: "absolute" | "relative";
  hasTime: boolean;
}

export interface RuleFacts {
  dates: DateHit[];
  primary?: DateHit;
  actionDeadline?: DateHit;
  kindHint?: EventKind;
  audience: Audience;
  links: string[];
  /** 原文出现"另行通知/待定"等表述 */
  uncertain: boolean;
}

const KIND_RULES: Array<{ kind: EventKind; re: RegExp }> = [
  { kind: "pe", re: /体测|体质|体能测试|体育测试|健康测试/ },
  { kind: "exam", re: /考试|补考|缓考|考场|四六级|六级|四级测验/ },
  {
    kind: "activity",
    re: /讲座|论坛|沙龙|嘉年华|开放日|运动会|校运会|竞赛|比赛|演出|晚会|招聘|宣讲|展览|活动/,
  },
];

const DEADLINE_SENTENCE = /截止|截至|报名|申请|提交|缴费|前完成|之前|务必于/;
const PRIMARY_CONTEXT = /(于|时间|日期|定于|拟于|举办|举行|开展|进行)\s*$/;

/**
 * 只有"时间/日期不确定"才算 uncertain。
 * "考场安排另行公布"不影响日期可信度，不该把整条记录打成待确认。
 */
const UNCERTAIN_RE = /(?:时间|日期)[^。；\n]{0,8}(?:另行|待定|另定)|待定|暂定/;

/** 正文切句，保留每句的起止位置，便于把日期归到句子上 */
function splitSentences(text: string) {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /[^。；;\n]+[。；;\n]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function timeNear(text: string, end: number): { hasTime: boolean; time: ReturnType<typeof parseTimeOfDay> } {
  const slice = text.slice(end, Math.min(text.length, end + 10));
  const time = parseTimeOfDay(slice);
  return { hasTime: Boolean(time), time };
}

export function extractByRules(text: string, anchorIso: string): RuleFacts {
  const body = text || "";
  const dates: DateHit[] = [];
  const covered: Array<[number, number]> = [];

  // 1) 带年份：2026年11月8日 / 2026-11-08 / 2026.11.8
  const withYear = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/g;
  let m: RegExpExecArray | null;
  while ((m = withYear.exec(body))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!validDate(y, mo, d)) continue;
    const { hasTime, time } = timeNear(body, m.index + m[0].length);
    const dateIso = formatIso(y, mo, d);
    dates.push({
      iso: combineDateTime(dateIso, time),
      dateIso,
      raw: m[0].trim(),
      index: m.index,
      source: "absolute",
      hasTime,
    });
    covered.push([m.index, m.index + m[0].length]);
  }

  // 2) 不带年份：11月8日 / 11月8号（年份按发布时间推断）
  const noYear = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((m = noYear.exec(body))) {
    const start = m.index;
    const end = start + m[0].length;
    if (covered.some(([a, b]) => start >= a && start < b)) continue;
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = inferYear(mo, d, anchorIso);
    if (!validDate(y, mo, d)) continue;
    const { hasTime, time } = timeNear(body, end);
    const dateIso = formatIso(y, mo, d);
    dates.push({
      iso: combineDateTime(dateIso, time),
      dateIso,
      raw: m[0].trim(),
      index: start,
      source: "absolute",
      hasTime,
    });
    covered.push([start, end]);
  }

  // 3) 相对时间：下周三 / 本周五 / 明天
  for (const phrase of RELATIVE_PHRASES) {
    let from = 0;
    for (;;) {
      const at = body.indexOf(phrase, from);
      if (at === -1) break;
      from = at + phrase.length;
      if (covered.some(([a, b]) => at >= a && at < b)) continue;
      const resolved = resolveRelative(phrase, anchorIso);
      if (!resolved) continue;
      const { hasTime, time } = timeNear(body, at + phrase.length);
      dates.push({
        iso: combineDateTime(resolved.iso, time),
        dateIso: resolved.iso,
        raw: phrase,
        index: at,
        source: "relative",
        hasTime,
      });
      covered.push([at, at + phrase.length]);
    }
  }

  dates.sort((a, b) => a.index - b.index);

  // 主日期：优先"定于/时间/举办"等上下文之后的那一个，其次取最早出现
  let primary: DateHit | undefined;
  let bestScore = -1;
  for (const hit of dates) {
    const before = body.slice(Math.max(0, hit.index - 12), hit.index);
    const score = PRIMARY_CONTEXT.test(before) ? 3 : 0;
    if (score > bestScore) {
      bestScore = score;
      primary = hit;
    }
  }

  // 行动截止：落在"截止/报名/提交"句子里的日期
  const sentences = splitSentences(body);
  let actionDeadline: DateHit | undefined;
  for (const sentence of sentences) {
    if (!DEADLINE_SENTENCE.test(sentence.text)) continue;
    const inSentence = dates.filter(
      (h) => h.index >= sentence.start && h.index < sentence.end
    );
    if (inSentence.length === 0) continue;
    actionDeadline = inSentence[inSentence.length - 1];
    break;
  }

  const kindHint = KIND_RULES.find((r) => r.re.test(body))?.kind;

  return {
    dates,
    primary,
    actionDeadline,
    kindHint,
    audience: extractAudience(body),
    links: extractLinks(body),
    uncertain: UNCERTAIN_RE.test(body),
  };
}

/** 只抽"明确写出"的归属，不做推断 */
export function extractAudience(text: string): Audience {
  const audience: Audience = {};

  const college = /([\u4e00-\u9fa5]{2,10}(?:学院|学部))/.exec(text);
  if (college) audience.college = college[1];

  const grade = /(20\d{2})\s*级/.exec(text);
  if (grade) audience.grade = Number(grade[1]);

  if (/博士生|博士研究生/.test(text)) audience.level = "doctoral";
  else if (/硕士生|硕士研究生/.test(text)) audience.level = "postgraduate";
  else if (/本科生|本科/.test(text)) audience.level = "undergraduate";

  return audience;
}

export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/[^\s"'<>（）()【】]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (url.length > 8 && url.length < 500) out.add(url);
  }
  return Array.from(out);
}
