export interface WeekAnchors {
  weekday: string;
  today: string;
  mondayThisWeek: string;
  sundayThisWeek: string;
  mondayNextWeek: string;
  sundayNextWeek: string;
}
export declare const MEETING_SCHEMA: string;
export declare function weekAnchors(now?: Date): WeekAnchors;
export declare function meetingSystemPrompt(a: WeekAnchors, fromImage?: boolean): string;
