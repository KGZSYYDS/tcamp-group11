/**
 * 站内提醒的计算。
 *
 * 数据来源不在这里管——调用方把 lib/deadlines.ts 合并好的截止列表传进来，
 * 这里只回答一个问题：**现在该提示哪几条**。
 *
 * 提醒提前量存在 note 里（见 lib/llm.ts 的 buildMeetingNote）：
 *   「来自群：X · 提醒:提前30分钟 · 原话：…」
 *   「… · 提醒:关 · …」  ← 用户主动关掉，必须尊重，一条都不提示
 * 没有这个字段的（作业、公文通截止）用默认提前量。
 */

export const DEFAULT_LEAD_MINUTES = 60;
export const URGENT_MINUTES = 60;
export const SOON_MINUTES = 360;

/**
 * 解析一条截止的提醒策略。
 * @param {string | null | undefined} note
 * @returns {{mode: "off" | "lead", minutes: number}}
 */
export function remindPolicyOf(note) {
  const text = String(note || "");
  if (/提醒\s*[:：]\s*关/.test(text)) return { mode: "off", minutes: 0 };

  const m = text.match(/提醒\s*[:：]\s*提前\s*(\d+)\s*分钟/);
  if (m) return { mode: "lead", minutes: Number(m[1]) };

  // 兼容手写的「提前 30 分钟」
  const loose = text.match(/提前\s*(\d+)\s*分钟/);
  if (loose) return { mode: "lead", minutes: Number(loose[1]) };

  return { mode: "lead", minutes: DEFAULT_LEAD_MINUTES };
}

/** 关闭键：带上截止时间，改了时间就重新提醒 */
export function reminderKey(deadline) {
  return `${deadline.key}@${deadline.dueAt}`;
}

const TZ_MS = 8 * 3600 * 1000;

/**
 * 按东八区取日期键。
 * 不能直接用本机 getFullYear/getDate：GitHub runner 是 UTC，
 * 那样「当天到期」会整体偏一天（本地 +08 与 CI 表现不一致）。
 */
function dateKey(d) {
  const t = new Date(d.getTime() + TZ_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function levelOf(minutesLeft) {
  if (minutesLeft <= URGENT_MINUTES) return "urgent";
  if (minutesLeft <= SOON_MINUTES) return "soon";
  return "today";
}

/**
 * 现在该提示哪些截止。
 *
 * @param {Array<{key:string,title:string,dueAt:string,note?:string,status?:string,source?:string,tag?:string,url?:string}>} deadlines
 * @param {{now?: Date|string|number, dismissed?: string[]}} [options]
 * @returns {{items: Array<object>, overdue: number, total: number, next: object | null}}
 */
export function computeReminders(deadlines, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) return { items: [], overdue: 0, total: 0, next: null };

  const dismissed = new Set(options.dismissed || []);
  const today = dateKey(now);
  const items = [];
  let overdue = 0;

  for (const d of deadlines || []) {
    if (!d || !d.dueAt) continue;
    if (d.status === "done") continue;

    const due = new Date(d.dueAt);
    if (Number.isNaN(due.getTime())) continue;

    const diffMs = due.getTime() - now.getTime();
    if (diffMs < 0) {
      overdue += 1;
      continue;
    }

    const policy = remindPolicyOf(d.note);
    if (policy.mode === "off") continue;

    const minutesLeft = Math.floor(diffMs / 60000);
    const inLead = minutesLeft <= policy.minutes;
    const sameDay = dateKey(due) === today;
    if (!inLead && !sameDay) continue;

    if (dismissed.has(reminderKey(d))) continue;

    items.push({ ...d, minutesLeft, level: levelOf(minutesLeft) });
  }

  items.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));

  return { items, overdue, total: items.length, next: items[0] || null };
}
