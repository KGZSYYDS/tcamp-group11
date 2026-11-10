export type Category = "course" | "homework" | "campus" | "personal" | "other";

export declare const CATEGORIES: Array<Exclude<Category, "other">>;

export declare function collegeNamesIn(text: string): string[];

export declare function isSchoolWide(title: string): boolean;

export interface CategoryInput {
  source?: string;
  rawKind: string;
  scope?: string;
  hasCollege: boolean;
  schoolWide: boolean;
  /**
   * 标题里的学院是否就是我的学院。
   * `undefined` 表示还不知道我是哪个学院（用户没设画像）——
   * 这种情况下不能断言「别的学院」，一律按校园处理。
   */
  isMine: boolean | undefined;
}

export declare function categoryOf(input: CategoryInput): Category;
