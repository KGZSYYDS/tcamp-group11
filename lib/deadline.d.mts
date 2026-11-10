/** 从通知正文里抽出「截止时间」的纯逻辑，见 lib/deadline.mjs。 */

export interface ExtractedDeadline {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm；原文没写钟点时为 null，入库会补 23:59 仅供排序 */
  time: string | null;
  expected: boolean;
  phrase: string;
}

export declare function extractDeadline(
  content: string,
  publishedAt?: string
): ExtractedDeadline | null;

export declare function isFacultyDeadline(title: string, content?: string): boolean;

export declare function isActionableDeadline(title: string): boolean;

export declare function debugDates(content: string): {
  dates: Array<{ idx: number; year: number | null; month: number; day: number; raw: string }>;
  time: string | null;
};

/** 备注里是否写了明确的钟点；false 表示库里的 23:59 只是排序值 */
export declare function hasExplicitClock(note?: string | null): boolean;

/** 剥掉备注里与卡片重复的「截止：… / 来自群：… / ｜发布：…」，只留原话 */
export declare function stripDeadlinePrefix(note?: string | null): string;
