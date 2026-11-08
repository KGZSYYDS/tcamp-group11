/**
 * 输入层的类型定义。
 *
 * 注意：这里**不规定**采集方用什么格式。`IngestEnvelope.payload` 是 unknown，
 * 具体结构由适配器（lib/ingest/adapters/*）去理解。
 * `RawRecord` 是我方的内部模型，不要求任何人遵守，也不对外暴露。
 */

export interface IngestEnvelope {
  /** 采集器标识，由我方按来源标注（可来自接口路径或文件名） */
  collector: string;
  /** 我方收到的时刻，ISO 8601 */
  receivedAt: string;
  /** 对方给什么就是什么，不做任何假设 */
  payload: unknown;
}

/** 缺失的关键信息。为空表示这条记录的 5 项能力齐备 */
export type MissingField = "url" | "title" | "content" | "publishedAt" | "stableId";

export const MISSING_LABEL: Record<MissingField, string> = {
  url: "缺原文链接",
  title: "缺标题",
  content: "缺正文",
  publishedAt: "缺发布时间",
  stableId: "缺稳定标识",
};

/**
 * 平台自带的结构化字段。
 * 畅课这类系统本来就返回 ISO 时间，不必再从正文里"抽"——走这条通道更可靠，
 * 也避免正文为空时整条记录被判为不可用。
 */
export interface RawRecordStructured {
  occurAt?: string;
  endAt?: string;
  actionDeadline?: string;
  kind?: string;
}

/** 内部模型：适配器的产物，只在 lib/pipeline/* 里流转 */
export interface RawRecord {
  collector: string;
  /** 已做规范化（去 utm、去锚点、域名小写）；空串表示原文没有链接 */
  url: string;
  title: string;
  /** 纯文本正文，已去 HTML 标签；平台只给结构化字段时可为空 */
  content: string;
  /** 兜底时间基准：没有 publishedAt 时用它 */
  receivedAt: string;
  publishedAt?: string;
  department?: string;
  /** 平台内稳定 id（如畅课 todo id），有它就能精确去重 */
  externalId?: string;
  /** 平台直接给出的时间，优先于文本抽取 */
  structured?: RawRecordStructured;
  /** 采集上下文：课程 id、页码、板块等，不参与去重 */
  context?: Record<string, string>;
  missing: MissingField[];
}

/** 适配器签名：一份 payload → 零到多条内部记录 */
export type Adapter = (
  payload: unknown,
  ctx: { collector: string; receivedAt: string }
) => RawRecord[];
