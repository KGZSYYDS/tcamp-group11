export interface ReminderDeadline {
  key: string;
  title: string;
  dueAt: string;
  note?: string | null;
  status?: "pending" | "done" | string;
  source?: string;
  tag?: string;
  url?: string;
}

export interface ReminderItem extends ReminderDeadline {
  /** 剩余分钟数（向上取整到分钟） */
  minutesLeft: number;
  level: "urgent" | "soon" | "today";
}

export interface ReminderResult {
  items: ReminderItem[];
  overdue: number;
  total: number;
  next: ReminderItem | null;
}

export declare const DEFAULT_LEAD_MINUTES: number;
export declare const URGENT_MINUTES: number;
export declare const SOON_MINUTES: number;

export declare function remindPolicyOf(note?: string | null): {
  mode: "off" | "lead";
  minutes: number;
};

export declare function reminderKey(deadline: Pick<ReminderDeadline, "key" | "dueAt">): string;

export declare function computeReminders(
  deadlines: ReminderDeadline[],
  options?: { now?: Date | string | number; dismissed?: string[] }
): ReminderResult;
