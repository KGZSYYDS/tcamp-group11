export interface PickedTime {
  /** YYYY-MM-DD；未识别到正文活动时间时为发布日期 */
  date: string;
  /** HH:mm；正文没写钟点时为 null */
  time: string | null;
  /** 正文里是否真的写了活动时间（false 表示 date 只是发布日期兜底） */
  found: boolean;
  /** 命中的原文片段，便于人工核对 */
  phrase: string;
  candidates: Array<{
    y: number;
    m: number;
    d: number;
    start: number;
    end: number;
    time: string | null;
    score: number;
    reasons: string[];
  }>;
}

export declare function pickEventTime(content: string, publishedAt?: string): PickedTime;
export declare function readClock(text: string): string | null;
export declare function debugTimes(
  content: string,
  publishedAt?: string
): Array<{ date: string; time: string | null; score: number; reasons: string[]; context: string }>;
