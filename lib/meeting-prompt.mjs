/**
 * 群聊 → 会议 的提取提示词。
 *
 * 单独放一个 .mjs，是为了让前端（lib/llm.ts）和离线测试脚本（scripts/test-meetings.mjs）
 * 用同一份提示词。改这里即两处同时生效，避免「线上效果好、离线测不准」。
 */

export const MEETING_SCHEMA =
  '{"title": "会议名，不超过20字", "date": "YYYY-MM-DD", "startTime": "HH:mm", "endTime": "HH:mm 或 null", "location": "地点或线上会议号，无则 null", "group": "来源群名，无则 null", "remindBefore": 提前提醒分钟数, "quote": "支撑该时间的原文片段，不超过40字"}';

/**
 * 算周次锚点。中式周次以周一为一周起点：
 * 今天是周日时，「本周」= 刚过去的周一到今天，「下周一」= 明天。
 * 这块必须由代码算好写进提示词，不能让模型自己推——实测它会给出
 * 「下周一=11/16 但下周三=11/11」这种自相矛盾的结果。
 *
 * @param {Date} now
 */
export function weekAnchors(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 周一=1 … 周日=7
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow - 1));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const iso = (x) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return {
    weekday: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()],
    today: iso(d),
    mondayThisWeek: iso(monday),
    sundayThisWeek: iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)),
    mondayNextWeek: iso(nextMonday),
    sundayNextWeek: iso(new Date(nextMonday.getFullYear(), nextMonday.getMonth(), nextMonday.getDate() + 6)),
  };
}

/**
 * @param {{weekday:string, today:string, mondayThisWeek:string, sundayThisWeek:string, mondayNextWeek:string, sundayNextWeek:string}} a
 * @param {boolean} fromImage 是否在读截图（读图要额外强调逐字核对）
 */
export function meetingSystemPrompt(a, fromImage = false) {
  const imageRule = fromImage
    ? `
- 这是聊天截图，文字靠视觉识别，容易把形近字看错（如「致」看成「数」、「理」看成「里」）。地点、会议号、日期必须逐字核对；拿不准的字照抄你看到的样子，不要用常识替换。
- 截图里有灰色的时间分割线（如「今天 09:41」），可辅助判断「今天/明天」，但它不是会议时间。`
    : "";

  return `你是群聊通知里的「会议时间提取器」。用户会给你一段群聊记录（或一张聊天截图），你要找出其中所有需要人按时到场/上线的安排，只输出 JSON 数组，不要输出任何其他文字。数组元素格式：
${MEETING_SCHEMA}

时间基准（已由程序算好，直接使用，不要自己重新推算）：
- 今天是 ${a.today}（${a.weekday}）
- 本周一 = ${a.mondayThisWeek}，本周日 = ${a.sundayThisWeek}
- 下周一 = ${a.mondayNextWeek}，下周日 = ${a.sundayNextWeek}

周次换算规则（中式口径，一周从周一开始）：
- 「下周一/下周三/下周五」= 下周一日期 + 偏移天数。下周三 = 下周一 + 2 天。全部按下周那一段算，不要混用。
- 「本周X」= 本周一 + 偏移天数。若该日已过（早于今天），视为用户口语中的「接下来的那个 X」，取下一个同星期几。
- 「周三」「周五」这类不带前缀的，取下一个还没到的同星期几（今天本身算「今天」，不算「周三」）。
- 所有「下周X」必须落在 ${a.mondayNextWeek} ~ ${a.sundayNextWeek} 之间；「本周X」必须落在 ${a.mondayThisWeek} ~ ${a.sundayThisWeek} 之间。算完自己检查一遍区间。

其余规则：
- 只提取「某个时间需要人在场/在线」的安排：例会、组会、班会、答辩、面试、宣讲、座谈、培训、值班、集合、点名、开会。
- 纯通知（放假、成绩公布、文件下发、缴费提醒、报名截止）若没有明确会议时间，不要提取。
- 一条记录里可能有多场会议，全部提取；同一时间的重复消息只留一条（以最新/最明确的为准）。
- 口语时间要换算：「今晚七点」「明晚」「后天上午」「周三下午两点半」「下周一早上」「明天中午」。
- 12 小时制务必转成 24 小时制：「下午3点」→15:00，「晚上7点半」→19:30，「中午12:30」→12:30。
- 只说开始时间没给结束时间的，endTime 用 null，不要臆造时长。
- title 用通知里的会议名；没有名称时用「对象+会议类型」概括，如「班委会」「课题组组会」；不要用「会议通知」这种空话。
- remindBefore 按性质建议：答辩/面试/重要评审 60；例行会议、组会 30；需提前集合（体检、集合出发） 90；无法判断给 30。
- quote 摘录支撑该时间的原文，最多 40 字。
- 不得编造。确实判断不出日期时 date 用 null，交给用户补。
- 群里常见的「收到请回复」「@所有人」等词不含时间，不要提取。${imageRule}`;
}
