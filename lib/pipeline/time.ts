/**
 * 时间归一化。
 *
 * 关键约定：
 * 1. 全部按东八区（+08:00）输出，与现有数据结构一致；中国无夏令时，固定偏移安全。
 * 2. 相对时间（"下周三"）必须以**发布时间**为基准，缺失才退收到时间；
 *    绝不能取"现在"，否则补采历史数据会把日期整体平移。
 * 3. 只给日期不给时间时按全天处理（00:00 + allDay）。
 */

const TZ_MS = 8 * 3600 * 1000;

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** 0=周日 … 6=周六 */
  dow: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO → 东八区各字段；非法输入返回 null */
export function shanghaiParts(iso?: string | null): DateParts | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + TZ_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

export function formatIso(y: number, m: number, d: number, hh = 0, mm = 0): string {
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:00+08:00`;
}

/** 只保留日期部分，统一到当天 00:00 */
export function startOfDay(iso: string): string {
  const p = shanghaiParts(iso);
  if (!p) return "";
  return formatIso(p.y, p.m, p.d);
}

export function addDays(iso: string, n: number): string {
  const p = shanghaiParts(iso);
  if (!p) return "";
  const base = Date.UTC(p.y, p.m - 1, p.d) + n * 86400000;
  const d = new Date(base);
  return formatIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** b - a，按天取整 */
export function dayDiff(a: string, b: string): number {
  const pa = shanghaiParts(a);
  const pb = shanghaiParts(b);
  if (!pa || !pb) return 0;
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((tb - ta) / 86400000);
}

/**
 * 只有月日时推断年份：
 * 若该月日比基准日期早 180 天以上，说明是"明年的事"（12 月发通知说 1 月 5 日）。
 */
export function inferYear(month: number, day: number, anchorIso: string): number {
  const a = shanghaiParts(anchorIso);
  if (!a) return new Date().getUTCFullYear();
  const cand = Date.UTC(a.y, month - 1, day);
  const anchor = Date.UTC(a.y, a.m - 1, a.d);
  const diffDays = (cand - anchor) / 86400000;
  return diffDays < -180 ? a.y + 1 : a.y;
}

const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
};

/** 周一=1 … 周日=7（把 JS 的 0 换算成 7，便于做"本周/下周"算术） */
function mondayIndex(dow: number): number {
  return dow === 0 ? 7 : dow;
}

export interface RelativeResult {
  /** 日期部分，00:00 */
  iso: string;
  /** 命中的原文短语 */
  matched: string;
}

/** 解析相对时间短语；不认识就返回 null（不猜） */
export function resolveRelative(phrase: string, anchorIso: string): RelativeResult | null {
  const text = (phrase || "").trim();
  const anchor = shanghaiParts(anchorIso);
  if (!text || !anchor) return null;
  const base = formatIso(anchor.y, anchor.m, anchor.d);
  const dow = mondayIndex(anchor.dow);

  const simple: Array<[RegExp, number]> = [
    [/^(今天|今日|本日)$/, 0],
    [/^(明天|明日)$/, 1],
    [/^(后天)$/, 2],
    [/^(大后天)$/, 3],
    [/^(昨天|昨日)$/, -1],
    [/^(前天)$/, -2],
  ];
  for (const [re, delta] of simple) {
    const m = re.exec(text);
    if (m) return { iso: addDays(base, delta), matched: m[0] };
  }

  let m = /^(本|这)周([一二三四五六日天])$/.exec(text);
  if (m) {
    const target = CN_DIGIT[m[2]];
    return { iso: addDays(base, target - dow), matched: m[0] };
  }

  m = /^下周([一二三四五六日天])$/.exec(text);
  if (m) {
    const target = CN_DIGIT[m[1]];
    return { iso: addDays(base, target - dow + 7), matched: m[0] };
  }

  m = /^(?:周|星期|礼拜)([一二三四五六日天])$/.exec(text);
  if (m) {
    const target = CN_DIGIT[m[1]];
    const delta = (target - dow + 7) % 7;
    return { iso: addDays(base, delta), matched: m[0] };
  }

  m = /^(\d{1,3})\s*天(?:之)?后$/.exec(text);
  if (m) return { iso: addDays(base, Number(m[1])), matched: m[0] };

  m = /^(\d{1,2})\s*周(?:之)?后$/.exec(text);
  if (m) return { iso: addDays(base, Number(m[1]) * 7), matched: m[0] };

  m = /^下个?月(\d{1,2})[日号]?$/.exec(text);
  if (m) {
    const month = anchor.m === 12 ? 1 : anchor.m + 1;
    const year = anchor.m === 12 ? anchor.y + 1 : anchor.y;
    return { iso: formatIso(year, month, Number(m[1])), matched: m[0] };
  }

  m = /^(?:本|这个?)月(\d{1,2})[日号]$/.exec(text);
  if (m) return { iso: formatIso(anchor.y, anchor.m, Number(m[1])), matched: m[0] };

  if (/^(月底|月末|本月末)$/.test(text)) {
    const last = new Date(Date.UTC(anchor.y, anchor.m, 0)).getUTCDate();
    return { iso: formatIso(anchor.y, anchor.m, last), matched: text };
  }
  if (/^下月初$/.test(text)) {
    const month = anchor.m === 12 ? 1 : anchor.m + 1;
    const year = anchor.m === 12 ? anchor.y + 1 : anchor.y;
    return { iso: formatIso(year, month, 1), matched: text };
  }

  return null;
}

/** 相对时间词表，供"证据校验"扫描原文用 */
export const RELATIVE_PHRASES = [
  "大后天", "今天", "今日", "明天", "明日", "后天", "昨天", "前天",
  "本周一", "本周二", "本周三", "本周四", "本周五", "本周六", "本周日", "本周天",
  "这周一", "这周二", "这周三", "这周四", "这周五", "这周六", "这周日", "这周天",
  "下周一", "下周二", "下周三", "下周四", "下周五", "下周六", "下周日", "下周天",
  "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天",
  "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日", "星期天",
  "月底", "月末", "本月末", "下月初",
];

export interface TimeOfDay {
  hh: number;
  mm: number;
}

const PERIOD_WORDS = "上午|早上|清晨|中午|下午|傍晚|晚上|晚间|晚";

/**
 * 从文本里取时刻。"11月8日下午3点" → 15:00。
 * 找不到就返回 null，交由上层按全天处理。
 */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const source = text || "";
  const re = new RegExp(
    `(${PERIOD_WORDS})?\\s*(\\d{1,2})\\s*[:：点时]\\s*(\\d{1,2})?\\s*分?`
  );
  const m = re.exec(source);
  if (!m) return null;

  const period = m[1] || "";
  let hh = Number(m[2]);
  const mm = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hh) || hh > 24 || mm > 59) return null;

  const isPm = /下午|傍晚|晚上|晚间|晚/.test(period);
  const isNoon = /中午/.test(period);
  if (isPm && hh < 12) hh += 12;
  else if (isNoon && hh < 12) hh += 12;
  else if (!isPm && !isNoon && /上午|早上|清晨/.test(period) && hh === 12) hh = 0;

  if (hh >= 24) hh = 0;
  return { hh, mm };
}

/** 日期 + 时刻 → ISO；无时刻则当天 00:00 */
export function combineDateTime(dateIso: string, time: TimeOfDay | null): string {
  const p = shanghaiParts(dateIso);
  if (!p) return "";
  return formatIso(p.y, p.m, p.d, time?.hh ?? 0, time?.mm ?? 0);
}
