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
  at: Date;
  boardSubtype?: string;
  allDay?: boolean;
  location?: string;
  /** 上层已有归一化匹配器时传入结论，传了就不再字符串比较 */
  collegeMatched?: boolean;
  titleCollegeMatched?: boolean;
  schoolWideTitle?: boolean;
}

export interface RelevanceResult {
  score: number;
  reasons: string[];
  related: boolean;
}

export declare function scoreEvent(
  input: RelevanceInput,
  viewer: RelevanceViewer,
  now?: Date
): RelevanceResult;

export declare function compareRelevance(
  a: { score: number; at: Date },
  b: { score: number; at: Date }
): number;
