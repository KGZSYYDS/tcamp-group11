/**
 * 活动时间择一。
 *
 * 一条公文里常同时出现好几个日期：印发日期、文号日期、报名截止、活动时间。
 * 原来直接取正文第一个日期，于是「根据《…》（2026年11月8日印发）…定于12月28日考试」
 * 会被记成 11 月 8 日，日历上就多了一个错的事件。
 *
 * 这里把所有候选日期都找出来，按上下文打分，选最像「事情发生时刻」的那个。
 * 返回结构保持 { date, time, found }，与 scripts/ingest-notices.mjs 原来的 extractWhen 一致，
 * 额外带 phrase（命中的原文片段）方便测试与人工核对，不写入 note。
 */

const ACTIVITY_STRONG = /(定于|拟于|举行|举办|开展|开讲|开班|进行|面试|笔试|报到|签到|典礼|开幕式)/;
const ACTIVITY_WEAK = /(时间|日期|于|活动|讲座|会议|地点)/;
const DEADLINE = /(截止|截至|报名|申请|提交|报送|缴费|申报|前完成)/;
const ISSUE = /(印发|发布|公布|发文|文号|通知日期)/;
/** 日期后面紧跟「前/之前」，几乎一定是截止而不是活动 */
const DEADLINE_SUFFIX = /^\s*(前|之前|以前|截止)/;

const CONTEXT_BEFORE = 20;
const CONTEXT_AFTER = 16;

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * 去掉详情页页脚带进来的噪音。
 * 采集到的正文结尾常有「更新于 2026-11-06 20:32」「阅读 128 次」，
 * 不清掉会被当成活动时间，实测把好几条讲座排到了发布日期。
 */
const PAGE_NOISE = [
  /更新于\s*\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /(?:发布|发表|更新|编辑)时间\s*[:：]\s*\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}(?:\s+\d{1,2}:\d{2})?/g,
  /阅读\s*\d+\s*次/g,
  /点击数\s*[:：]\s*\d+/g,
];

function stripPageNoise(text) {
  let out = text;
  for (const re of PAGE_NOISE) out = out.replace(re, " ");
  return out;
}

function parseParts(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const probe = new Date(Date.UTC(yy, mm - 1, dd));
  if (probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) return null;
  return { y: yy, m: mm, d: dd };
}

function addDays(y, m, d, days) {
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function diffDays(a, b) {
  return Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86400000
  );
}

/**
 * 只有月日时补年份：比发布日晚半年以上，说明是「明年的事」
 * （12 月发通知说 1 月 5 日报名）。
 */
function inferYear(m, d, pub) {
  const cand = { y: pub.y, m, d };
  return diffDays(cand, pub) < -180 ? { ...cand, y: pub.y + 1 } : cand;
}

/** 从日期后面取钟点，支持 14:30 / 下午3点 / 上午9点半 */
export function readClock(text) {
  const source = text || "";
  const period = /(上午|下午|晚上|中午|早上|凌晨)/.exec(source)?.[1] || "";

  // 时间段取开始：14:00-16:00 / 上午 10-11 点
  let m = source.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-—~至]\s*\d{1,2}\s*[:：]\s*\d{2}/);
  if (m) {
    let hh = Number(m[1]);
    const mm = Number(m[2]);
    if (_isPm(period) && hh < 12) hh += 12;
    if (hh <= 24 && mm <= 59) return `${pad(hh)}:${pad(mm)}`;
  }

  m = source.match(/(\d{1,2})\s*[-—~至]\s*\d{1,2}\s*[点時时]/);
  if (m) {
    let hh = Number(m[1]);
    if (_isPm(period) && hh < 12) hh += 12;
    if (hh <= 24) return `${pad(hh)}:00`;
  }

  m = source.match(/(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m) {
    let hh = Number(m[2]);
    const mm = Number(m[3]);
    const p = m[1] || period;
    if (_isPm(p) && hh < 12) hh += 12;
    else if (/中午/.test(p) && hh < 12) hh += 12;
    else if (/凌晨/.test(p) && hh === 12) hh = 0;
    if (hh > 24 || mm > 59) return null;
    return `${pad(hh)}:${pad(mm)}`;
  }

  m = source.match(/(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[点時时]\s*(半|\d{1,2})?\s*分?/);
  if (m) {
    let hh = Number(m[2]);
    const mm = m[3] === "半" ? 30 : m[3] ? Number(m[3]) : 0;
    const p = m[1] || period;
    if (_isPm(p) && hh < 12) hh += 12;
    else if (/中午/.test(p) && hh < 12) hh += 12;
    else if (/凌晨/.test(p) && hh === 12) hh = 0;
    if (hh > 24 || mm > 59) return null;
    return `${pad(hh)}:${pad(mm)}`;
  }
  return null;
}

function _isPm(period) {
  return /下午|晚上|傍晚|晚/.test(period || "");
}

/**
 * 上下文只取「同一个小句」。
 * 否则「…（2026年11月8日印发），…定于12月28日」里 12/28 也会被前一句的「印发」扣分，
 * 报名截止与活动时间写在一起时同理。
 */
const CLAUSE_SEP = /[，。；：、,;:!?！？\n（(]/;

function tailClause(text, start, max) {
  const seg = text.slice(Math.max(0, start - max), start);
  const parts = seg.split(CLAUSE_SEP);
  return parts[parts.length - 1].slice(-14);
}

function headClause(text, end, max) {
  const seg = text.slice(end, end + max);
  const head = seg.split(CLAUSE_SEP)[0];
  // 日期后面紧跟「（星期四）19:00」这类括号时，首段会为空，退回原始片段
  return head.trim() ? head : seg;
}

/** 找出正文里所有候选日期 */
function collectDates(text, pub) {
  const out = [];
  const covered = [];

  const push = (y, m, d, start, end) => {
    const parts = parseParts(y, m, d);
    if (!parts) return;
    if (covered.some(([a, b]) => start < b && end > a)) return;
    covered.push([start, end]);
    const afterRaw = text.slice(end, end + CONTEXT_AFTER);
    out.push({
      ...parts,
      start,
      end,
      time: readClock(afterRaw),
      before: tailClause(text, start, CONTEXT_BEFORE),
      after: headClause(text, end, 16),
      afterRaw,
    });
  };

  // 1) 带年份：2026年11月8日 / 2026-11-08 / 2026.11.8
  const full = /(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/g;
  let m;
  while ((m = full.exec(text))) {
    push(m[1], m[2], m[3], m.index, m.index + m[0].length);
  }

  // 2) 只有月日：11月8日 / 11月8号
  const short = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
  while ((m = short.exec(text))) {
    const parts = inferYear(Number(m[1]), Number(m[2]), pub);
    push(parts.y, parts.m, parts.d, m.index, m.index + m[0].length);
  }

  return out.sort((a, b) => a.start - b.start);
}

/** 给单个候选打分 */
function scoreOf(cand, pub) {
  const reasons = [];
  let score = 0;

  if (ACTIVITY_STRONG.test(cand.before)) {
    score += 3;
    reasons.push("活动锚点");
  } else if (ACTIVITY_WEAK.test(cand.before)) {
    score += 1;
    reasons.push("弱活动锚点");
  }

  // 「地点」常与时间同句，但不足以单独定日期，故只给弱分

  if (cand.time) {
    score += 2;
    reasons.push("带钟点");
  }

  if (DEADLINE.test(cand.before) || DEADLINE_SUFFIX.test(cand.afterRaw)) {
    score -= 4;
    reasons.push("截止语境");
  }

  // 印发/发布 常写在日期后面：「（2026年11月8日印发）」
  if (ISSUE.test(cand.before) || ISSUE.test(cand.afterRaw.slice(0, 4))) {
    score -= 2;
    reasons.push("发文语境");
  }

  const delta = diffDays(cand, pub);
  if (delta > 0) {
    score += 1;
    reasons.push("未过期");
  } else if (delta === 0) {
    // 与发布日期同日：多半是「印发日期」被当成了活动时间，轻微减分
    score -= 1;
    reasons.push("与发布同日");
  } else {
    score -= 1;
    reasons.push("已过期");
  }

  return { score, reasons };
}



/** 把 hh + mm + 上午/下午 归一成 HH:mm；非法返回 null */
function clockOf(hh, mm, period) {
  let h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (_isPm(period) && h < 12) h += 12;
  else if (/中午/.test(period || "") && h < 12) h += 12;
  else if (/凌晨/.test(period || "") && h === 12) h = 0;
  if (h > 24 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/**
 * 同一段话里的所有时间段。
 * 「14:00-17:30」一段；「8:30-12:00、14:00-17:30」两段（分上下午）。
 */
export function readRanges(text) {
  const src = String(text || "");
  const out = [];

  const re = /(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-—~至]\s*(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let m;
  while ((m = re.exec(src))) {
    const start = clockOf(m[2], m[3], m[1] || "");
    const end = clockOf(m[5], m[6], m[4] || m[1] || "");
    if (start && end && end > start) out.push({ start, end });
  }

  const re2 = /(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[-—~至]\s*(\d{1,2})\s*[点時时]/g;
  while ((m = re2.exec(src))) {
    const start = clockOf(m[2], 0, m[1] || "");
    const end = clockOf(m[3], 0, m[1] || "");
    if (start && end && end > start) out.push({ start, end });
  }

  // 「9点-11点」：点在横线前面，另一种常见写法
  const re3 = /(上午|下午|晚上|中午|早上|凌晨)?\s*(\d{1,2})\s*[点時时]\s*[-—~至]\s*(\d{1,2})\s*[点時时]/g;
  while ((m = re3.exec(src))) {
    const start = clockOf(m[2], 0, m[1] || "");
    const end = clockOf(m[3], 0, m[1] || "");
    if (start && end && end > start) out.push({ start, end });
  }

  // 去重并按开始时间排序，最多 4 段，防止个别通知列十几场把日历撑爆
  const seen = new Set();
  return out
    .filter((r) => (seen.has(r.start + r.end) ? false : (seen.add(r.start + r.end), true)))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 4);
}

/** 「时长 2 小时」「持续 90 分钟」 */
function readDuration(text) {
  const m = /(?:时长|持续|历时|全程)\s*(?:约|大约)?\s*(\d+(?:\.\d+)?)\s*(小时|分钟|h|min)/i.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /小时|h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
}

/**
 * 读日期区间：「11月12日至14日」「11月12日-11月14日」。
 * 只认与起始日期同月或在起始日之后的，避免把无关区间套上来。
 */
export function readEndDate(text, start) {
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-—~至]\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/.exec(String(text || ""));
  if (!m) return null;
  const m1 = Number(m[1]);
  const d1 = Number(m[2]);
  const m2 = m[3] ? Number(m[3]) : m1;
  const d2 = Number(m[4]);
  // 必须从起始日开始，否则是另一件事的区间
  if (m1 !== start.m || d1 !== start.d) return null;
  if (m2 === m1 && d2 <= d1) return null;
  // 跨年（12月30日至1月3日）是合法的，用起止天数兜住离谱区间
  const year = m2 < m1 ? start.y + 1 : start.y;
  const from = new Date(start.y, start.m - 1, start.d);
  const to = new Date(year, m2 - 1, d2);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (days <= 0 || days > 60) return null;
  return `${year}-${pad(m2)}-${pad(d2)}`;
}

/**
 * @param {string} content 正文
 * @param {string} publishedAt 发布日期 YYYY-MM-DD
 * @returns {{date:string,time:string|null,found:boolean,phrase:string,candidates:Array}}
 */
export function pickEventTime(content, publishedAt) {
  const text = stripPageNoise(String(content || ""));
  const pubDate = /^\d{4}-\d{2}-\d{2}$/.test(String(publishedAt || ""))
    ? String(publishedAt)
    : new Date().toISOString().slice(0, 10);
  const [py, pm, pd] = pubDate.split("-").map(Number);
  const pub = { y: py, m: pm, d: pd };

  const candidates = collectDates(text, pub).map((cand) => {
    const { score, reasons } = scoreOf(cand, pub);
    return { ...cand, score, reasons };
  });

  if (candidates.length === 0) {
    return { date: pubDate, time: null, endDate: null, endTime: null, durationMin: null, sessions: [], found: false, phrase: "", candidates: [] };
  }

  let best = candidates[0];
  for (const cand of candidates) {
    // 分数相同时取更早出现的，保持可预期
    if (cand.score > best.score) best = cand;
  }

  const date = `${best.y}-${pad(best.m)}-${pad(best.d)}`;
  const phrase = text
    .slice(Math.max(0, best.start - 8), Math.min(text.length, best.end + 14))
    .replace(/\s+/g, " ")
    .trim();

  // 正文只有印发日期这类「不是事情本身」的日期时，found=false，交给下游按发布日期兜底
  if (best.score <= 0) {
    return { date: pubDate, time: null, endDate: null, endTime: null, durationMin: null, sessions: [], found: false, phrase, candidates };
  }

  // 结束时间 / 日期区间 / 多时段：都从选中的那段上下文里读，
  // 避免把「报名截止 11月20日」这种另一件事的时间当成活动结束
  const window = text.slice(Math.max(0, best.start - 10), Math.min(text.length, best.end + 80));
  const ranges = best.time ? readRanges(window) : [];
  const endDate = readEndDate(window, { y: best.y, m: best.m, d: best.d });
  const durationMin = readDuration(window);

  // 单段：start/end 用解析到的时段；多段：每段一条 session
  let sessions;
  if (ranges.length > 1) {
    sessions = ranges.map((r) => ({ date, start: r.start, end: r.end }));
  } else if (ranges.length === 1) {
    sessions = [{ date, start: ranges[0].start, end: ranges[0].end }];
  } else if (best.time) {
    const plus = durationMin ? addClock(best.time, durationMin) : null;
    sessions = [{ date, start: best.time, end: plus }];
  } else {
    sessions = [{ date, start: null, end: null }];
  }

  return {
    date,
    time: best.time,
    endDate,
    endTime: sessions[0]?.end ?? null,
    durationMin,
    sessions,
    found: true,
    phrase,
    candidates,
  };
}

/** HH:mm + 分钟数 → HH:mm（跨天返回 null） */
function addClock(clock, minutes) {
  const [h, m] = String(clock).split(":").map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60) return null;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 调试用：打印所有候选与打分，排查「为什么选了这天」 */
export function debugTimes(content, publishedAt) {
  const result = pickEventTime(content, publishedAt);
  return result.candidates.map((c) => ({
    date: `${c.y}-${pad(c.m)}-${pad(c.d)}`,
    time: c.time,
    score: c.score,
    reasons: c.reasons,
    context: `${c.before}【】${c.after.slice(0, 10)}`.replace(/\s+/g, " "),
  }));
}
