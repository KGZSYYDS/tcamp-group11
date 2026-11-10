import type { EventKind } from "../../types";

/**
 * LLM 通道：只定义"要它产出什么"和"怎么问"，不在这里发起网络请求。
 * 真正的调用方（云 SDK / 本地模型）通过 ExtractorFn 注入，管道因此保持纯函数、可离线测试。
 */

export interface LlmAudience {
  college?: string | null;
  grade?: number | string | null;
  level?: string | null;
  class?: string | null;
  course?: string | null;
}

export interface LlmFacts {
  title?: string | null;
  kind?: EventKind | null;
  /** YYYY-MM-DD */
  date?: string | null;
  endDate?: string | null;
  /** HH:mm */
  time?: string | null;
  actionDeadline?: string | null;
  location?: string | null;
  link?: string | null;
  audience?: LlmAudience | null;
  /** 原文中支撑该日期的短语，供证据校验使用 */
  datePhrase?: string | null;
  actionPhrase?: string | null;
  /** 模型自评 0~1，仅作为参考，不直接采信 */
  selfConfidence?: number | null;
}

export type ExtractorFn = (input: {
  title: string;
  body: string;
  anchor: string;
}) => Promise<LlmFacts | null>;

const SYSTEM_PROMPT = [
  "你是校园通知结构化助手。从给定标题与正文中抽取日历事件字段。",
  "硬性要求：",
  "1) 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。",
  "2) 任何日期都必须能在正文中找到依据；找不到就填 null，禁止推测。",
  "3) 标题改写是不允许的：title 字段原样返回给出的标题。",
  "4) 相对时间（明天/下周三）以给定的发布时间为基准换算，并在 datePhrase 里写出原文短语。",
  "5) 没有明确写出学院/年级/班级时，audience 留空对象，不要猜。",
  "输出字段：title, kind(exam|pe|activity|other), date, time, endDate, actionDeadline,",
  "location, link, audience{college,grade,level,class,course}, datePhrase, actionPhrase, selfConfidence。",
].join("\n");

export function buildExtractionMessages(input: {
  title: string;
  body: string;
  anchor: string;
}): Array<{ role: "system" | "user"; content: string }> {
  const user = [
    `发布时间（基准，东八区）：${input.anchor}`,
    `标题：${input.title}`,
    "正文：",
    input.body.slice(0, 6000),
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** 从模型返回的文本里抠出 JSON；失败返回 null，绝不"猜一个" */
export function parseLlmJson(raw: string): LlmFacts | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as LlmFacts;
  } catch {
    return null;
  }
}

/** 无模型可用时的空实现：管道照常跑，只是退化成纯规则 */
export const noopExtractor: ExtractorFn = async () => null;
