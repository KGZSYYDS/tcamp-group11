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
  isMine: boolean;
}

export declare function categoryOf(input: CategoryInput): Category;
