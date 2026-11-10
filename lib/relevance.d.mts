export interface RelevanceViewer {
  college?: string;
  major?: string;
  grade?: string;
  /** undergraduate / postgraduate / doctoral */
  level?: string;
  /** 本机课表里的课程名 */
  courses?: string[];
}

export interface RelevanceInput {
  kind: string;
  title: string;
  note?: string;
  scope?: string;
  college?: string;
  grade?: string;
  at: Date;
  allDay?: boolean;
  location?: string;
}

export interface RelevanceResult {
  score: number;
  reasons: string[];
  related: boolean;
}

export declare const RELATED_THRESHOLD: number;

export declare function scoreEvent(
  input: RelevanceInput,
  viewer: RelevanceViewer,
  now?: Date
): RelevanceResult;

export declare function compareRelevance(
  a: { score: number; at: Date },
  b: { score: number; at: Date }
): number;
