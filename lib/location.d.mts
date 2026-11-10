export type LocationKind = "physical" | "online" | null;

export interface ExtractedLocation {
  location: string | null;
  kind: LocationKind;
  /** 0.95 标注式 / 0.9 线上带号 / 0.7 叙述式 / 0 未命中 */
  confidence: number;
  rule: "label" | "online" | "narrative" | null;
  /** 命中的原文片段，回填 CSV 里给人核对 */
  phrase: string;
}

export declare function extractLocation(content: string): ExtractedLocation;

export declare function isLikelyLocation(value: string): boolean;
