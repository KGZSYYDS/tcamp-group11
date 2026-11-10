/**
 * 微信聊天记录 → 日历事项（**纯本地、纯规则，不联网**）
 *
 * 为什么不用模型：这一层的承诺是「聊天记录不出这台设备」。一旦把正文送去
 * 云端模型，这句话就不成立了，用户点「同意」时理解的也不是这个。
 * 所以这里只有正则和日期算术 —— 召回率不如模型，但换来了可解释、可离线、
 * 零上传。质量不够时用户还能逐条删，比「悄悄上传」好。
 *
 * 输入是用户自己导出的文件（WeFlow 的 JSON、或 `[MM-DD HH:mm] 昵称: 内容`
 * 这种文本）。输出是 lib/local-store 的 PersonalItem，直接进 localStorage。
 */

import type { PersonalItem } from "./local-store";

export interface ChatFile {
  name: string;
  text: string;
  /** 文件最后修改时间，用来兜住「消息本身没有年份」的情况 */
  lastModified?: number;
}

interface Message {
  /** 这条消息的发送时间；没有就退回文件时间/今天 */
  at: Date;
  sender: string;
  text: string;
  /** 来源标识，写进 note 方便回查 */
  from: string;
  /** 原消息的稳定 id（WeFlow 有 localId），用于去重 */
  key: string;
}

export interface ExtractResult {
  items: PersonalItem[];
  /** 扫了多少条消息、多少条带时间线索 */
  scanned: number;
  hinted: number;
  /** 每条输入文件的解析情况，给用户看「读了什么」 */
  files: { name: string; messages: number; error?: string }[];
}

// ---------- 读文件 ----------

const MAX_BYTES = 40 * 1024 * 1024;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * WeFlow 5.x 的 `type` 是**中文**（"文本消息" / "引用消息" / "图片消息"），
 * 而且同一条消息还带一个 `localType` 数字。早期只认 1/"text"，把真实导出
 * 文件喂进来会一条都读不到 —— 这是实测才暴露的（见 docs §六）。
 * 图片/语音/表情/系统消息没有可排期的文字，照旧跳过。
 */
const WEFLOW_TEXT_TYPES = new Set([
  "文本消息",
  "链接消息",
  "文件消息",
  "聊天记录",
  "小程序消息",
  "引用消息",
  "视频号消息",
  "位置消息",
  "名片消息",
]);

function isTextMessage(type: unknown, localType: unknown): boolean {
  if (type === undefined || type === null) return true;
  if (type === 1 || type === "1" || type === "text") return true;
  if (typeof type === "string" && WEFLOW_TEXT_TYPES.has(type)) return true;
  // 兜底：localType=1 是微信的文本类型
  return localType === 1 || localType === "1";
}

/** WeFlow 导出：数组，字段见 docs §3.5；也兼容 { messages: [...] } 包装 */
function fromWeFlowJson(json: unknown): Message[] | null {
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { messages?: unknown })?.messages)
    ? ((json as { messages: unknown[] }).messages)
    : null;
  if (!arr || arr.length === 0) return null;

  const first = arr[0] as Record<string, unknown>;
  const looksLikeChat =
    "content" in first || "msg" in first || "text" in first || "senderDisplayName" in first;
  if (!looksLikeChat) return null;

  const out: Message[] = [];
  for (const raw of arr) {
    const m = raw as Record<string, unknown>;
    // 用中文 type + localType 双重判断，见 isTextMessage
    if (!isTextMessage(m.type, m.localType)) continue;

    const rawText = String(m.content ?? m.msg ?? m.text ?? "").trim();
    /**
     * 引用消息里带着一大段被引用的原话。不剥掉的话，被引用那条旧通知的
     * 「会议」「活动」「截止」会把这一条的分类和日期全带偏 —— 实测里
     * 「简历 11月6日截止」被判成了会议，就是因为引用块里有个「交流会」。
     */
    const text = rawText
      .replace(/[\[【]\s*引用[\s\S]*?[\]】]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    let at: Date | null = null;
    const ct = m.createTime ?? m.create_time ?? m.timestamp ?? m.time;
    if (typeof ct === "number" || /^\d{10,13}$/.test(String(ct ?? ""))) {
      const n = Number(ct);
      at = new Date(n > 1e12 ? n : n * 1000);
    } else if (typeof ct === "string" || typeof m.formattedTime === "string") {
      const s = String(ct ?? m.formattedTime).replace(/[/.]/g, "-");
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) at = d;
    }

    out.push({
      at: at && !Number.isNaN(at.getTime()) ? at : new Date(),
      sender: String(m.senderDisplayName ?? m.sender ?? m.from ?? ""),
      text,
      from: String(m.sessionName ?? m.groupName ?? ""),
      key: String(m.localId ?? m.id ?? `${text.slice(0, 24)}`),
    });
  }
  return out;
}

/**
 * 文本形态：
 *   [11-09 14:30] 辅导员: 明天下午三点在致理楼开会
 *   2026-11-09 14:30 张三：周四前交表
 *   辅导员：明天下午三点开会        （微信「昵称：内容」式，没时间戳）
 */
function fromText(text: string, fallback: Date): Message[] {
  const out: Message[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length < 4) continue;

    let m = t.match(
      /^\[?(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\]?\s*([^:：]{0,20})?[:：]?\s*(.+)$/
    );
    let at: Date | null = null;
    let sender = "";
    let body = t;

    if (m) {
      at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      sender = (m[6] || "").trim();
      body = m[7];
    } else {
      m = t.match(/^\[?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*([^:：]{0,20})?[:：]?\s*(.+)$/);
      if (m) {
        // 没年份：锚在文件时间所在年，跨年时（12 月看到 1 月的消息）往前推一年
        const y = fallback.getFullYear();
        const d = new Date(y, +m[1] - 1, +m[2], +m[3], +m[4]);
        if (d.getTime() - fallback.getTime() > 180 * 86400_000) d.setFullYear(y - 1);
        at = d;
        sender = (m[5] || "").trim();
        body = m[6];
      } else {
        // 「昵称：内容」——微信手动复制最常见的样子，没有时间戳，用文件时间兜底
        m = t.match(/^([^\s:：]{1,16})\s*[:：]\s*(.+)$/);
        if (m && !/[，。！？、；]/.test(m[1])) {
          at = fallback;
          sender = m[1];
          body = m[2];
        }
      }
    }

    if (!at || Number.isNaN(at.getTime())) {
      // 没有时间戳的行也留一条：日期表达本身可能就是「明天开会」这种
      at = fallback;
    }
    body = body.trim();
    if (!body) continue;
    out.push({ at, sender, text: body, from: "", key: `${dateKey(at)}-${body.slice(0, 24)}` });
  }
  return out;
}

export function readChatFile(file: ChatFile): { messages: Message[]; error?: string } {
  if (file.text.length > MAX_BYTES) {
    return { messages: [], error: "文件超过 40MB，先在导出工具里缩小日期范围" };
  }
  const fallback = file.lastModified ? new Date(file.lastModified) : new Date();

  const trimmed = file.text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const msgs = fromWeFlowJson(json);
      if (msgs) {
        for (const m of msgs) if (!m.from) m.from = file.name.replace(/\.\w+$/, "");
        return { messages: msgs };
      }
      // 是 JSON 但不是聊天记录 —— 明确报错，别静默跳过
      return { messages: [], error: "JSON 里没有消息数组，确认选的是聊天记录导出文件" };
    } catch {
      /* 不是合法 JSON，按文本继续 */
    }
  }
  const msgs = fromText(trimmed, fallback);
  for (const m of msgs) if (!m.from) m.from = file.name.replace(/\.\w+$/, "");
  return { messages: msgs };
}

// ---------- 日期 / 时间 ----------

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** 从一条消息里解出「哪一天」。返回 null 表示没有可靠日期 */
function resolveDate(text: string, anchor: Date): Date | null {
  // 1) 完整年月日
  let m = text.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  // 2) 相对日
  const rel: Record<string, number> = {
    今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今儿: 0,
    明天: 1, 明日: 1, 明晚: 1, 明早: 1,
    后天: 2, 后晚: 2,
    大后天: 3,
  };
  for (const [w, off] of Object.entries(rel)) {
    if (text.includes(w)) {
      const d = new Date(anchor);
      d.setDate(d.getDate() + off);
      return d;
    }
  }

  /**
   * 3) 只有月日：按锚点年份；若已过去半年以上，视为明年（预报名这类）
   *
   * 必须排在「周几」前面：正文里常见「12月3日（周四）」这种带括号星期的写法，
   * 先匹配周几会把它算成本周四，日期整体偏掉两个月。
   */
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const d = new Date(anchor.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() - anchor.getTime() > 180 * 86400_000) d.setFullYear(d.getFullYear() - 1);
    return d;
  }

  // 4) 周几（本周/这周/下周）
  m = text.match(/(本|这|下)?\s*周([一二三四五六日天])/);
  if (m) {
    const target = WEEKDAY[m[2]];
    const d = new Date(anchor);
    // 以周一为一周起点换算偏移：正数 = 本周内还没到，负数 = 本周内已过去。
    // 原先用 (target - cur + 7) % 7 恒非负，导致周三说「本周一」被算成下周一。
    const curIdx = (d.getDay() + 6) % 7;
    const targetIdx = (target + 6) % 7;
    let delta = targetIdx - curIdx;
    if (m[1] === "下") {
      delta += 7;
    } else if (m[1] !== "本" && m[1] !== "这" && delta < 0) {
      // 只说「周一」时按最近的那个将来理解，往回推一次到下周
      delta += 7;
    }
    d.setDate(d.getDate() + delta);
    return d;
  }

  return null;
}

/** 解出钟点。"下午三点" → 15:00；返回 null 表示只到天不到点 */
function resolveTime(text: string): { h: number; m: number } | null {
  // 1) 14:30 / 14：30
  let m = text.match(/(?:^|[^\d])([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/);
  if (m) return { h: +m[1], m: +m[2] };

  // 2) 下午3点 / 晚上七点半 / 两点（中文「两」很常见，漏了就丢时间）
  m = text.match(/(上午|早上|中午|下午|傍晚|晚上|晚)?\s*(\d{1,2}|[一二三四五六七八九十两]{1,3})\s*[点时](半|\d{1,2}\s*分)?/);
  if (m) {
    const cn: Record<string, number> = {
      一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
      十一: 11, 十二: 12,
    };
    let h = /^\d+$/.test(m[2]) ? +m[2] : cn[m[2]];
    if (h === undefined || h > 24) return null;
    const period = m[1] || "";
    if (/下午|傍晚|晚上|晚/.test(period) && h < 12) h += 12;
    if (period === "中午" && h < 11) h += 12;
    const mm = m[3] === "半" ? 30 : m[3] ? parseInt(m[3], 10) : 0;
    return { h: h % 24, m: mm || 0 };
  }

  return null;
}

// ---------- 标题 / 类型 / 地点 ----------

const DEADLINE_RE =
  /(截止|ddl|deadline|之前|前提交|前完成|前报名|前填写|前上交|前交|前发|前报|前上传|前确认|报名截止|提交时间|上交|报送|务必于|\d{1,2}\s*[日号]\s*前|周[一二三四五六日天]\s*前)/i;
const MEETING_RE =
  /(会议|开会|例会|班会|讲座|宣讲|培训|答辩|考试|体测|集合|签到|上课|活动|分享会|面试|路演|座谈|仪式|演出|比赛|竞赛|体检|沙龙|论坛|研讨|报告会|讲坛|展览|参观|双选会|招聘)/;

/**
 * 强截止词：出现这些，主体基本就是「某时间之前要做什么」。
 * 和 DEADLINE_RE 的区别是这里不收「之前」这种泛词（「开会之前记得带材料」不是截止）。
 */
const STRONG_DEADLINE_RE =
  /(截止|截至|ddl|deadline|提交时间|报名截止|前提交|前填写|前上交|前交|前报名|前上传|前确认|前发|前报|\d{1,2}\s*[日号]\s*前|周[一二三四五六日天]\s*前)/i;

function classify(text: string): PersonalItem["kind"] | null {
  const isDeadline = DEADLINE_RE.test(text);
  const isMeeting = MEETING_RE.test(text);

  // 提到截止就先按截止处理。「会议材料请于X日前提交」「简历11月6日截止」
  // 这类句子里也会出现「会议」「交流会」，之前按「有没有会」判断，实测全判反了。
  if (STRONG_DEADLINE_RE.test(text)) {
    // 唯一例外：明确在说「某天开会/举办活动」，截止只是个附带条件
    const isHolding = /(召开|举行|举办|开班|开讲)/.test(text);
    const isSubmitting = /(截止|前提交|前填写|前交)/.test(text);
    if (isHolding && !isSubmitting) return "meeting";
    return "deadline";
  }

  if (isDeadline && !isMeeting) return "deadline";
  if (isDeadline && isMeeting) {
    // 「会议材料请于X日前提交」主体是截止；「明天开会，记得带材料」主体是会议
    return /(请|务必|记得|需要)?(于|在)?[^。]{0,20}(前|截止)/.test(text) &&
      !/(召开|举行|举办|开|参加|出席)[^。]{0,10}(会|讲座|活动)/.test(text)
      ? "deadline"
      : "meeting";
  }
  if (isMeeting) return "meeting";
  return null;
}

/** 一句话里有没有「可排期」的信息量，用来挑标题 */
const TITLE_HINT_RE =
  /(截止|ddl|deadline|之前|前提交|前报名|前交|前填|前上传|前确认|开会|会议|例会|班会|讲座|宣讲|培训|答辩|考试|体测|报名|提交|材料|集合|签到|活动|面试|招聘|路演|座谈|\d{1,2}\s*[月日号])/i;

function cleanTitle(text: string): string {
  let t = text
    .replace(/^[\s【\[（(]+(通知|公告|提醒|重要|紧急)[】\]）)]\s*/g, "")
    .replace(/^@所有人\s*/, "")
    .replace(/^各位(同学|老师|同事)[，,、]\s*/, "")
    .replace(/^\s*[:：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  /**
   * 按句切，再挑「有信息量」的那一句。
   * 群聊里常见「收到。另外四六级报名 11月20日前截止」——
   * 只看第一句会得到「收到」，整条被当噪声丢掉。
   */
  const sentences = t
    .split(/[。；;！!？?\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = sentences.find((s) => s.length >= 4 && TITLE_HINT_RE.test(s)) || sentences[0] || t;
  t = first.trim();
  if (t.length > 40) {
    // 尽量在逗号处断开，别把词切一半
    const cut = t.slice(0, 40);
    const comma = cut.lastIndexOf("，");
    t = (comma > 12 ? cut.slice(0, comma) : cut) + "…";
  }
  return t;
}

function extractLocation(text: string): string | null {
  const m = text.match(
    /(?:地点|地址|位置)[:：]?\s*([^\s，。,；;]{2,24}(?:楼|室|厅|馆|校区|中心|教室|广场|场|栋|座|会议室))/
  );
  if (m) return m[1];
  const m2 = text.match(/(?:在|到)\s*([^\s，。,；;]{2,20}(?:楼|室|厅|馆|会议室|教室))/);
  return m2 ? m2[1] : null;
}

// ---------- 主入口 ----------

/**
 * 家政/二手/拼车群里的「表单式广告」不是日程。
 *
 * 实测：深圳家教群 7 天 84 条消息被抽出 42 条「事项」，全是
 * 「订单 xxx【地址】xx【学科】xx【年级】xx」这种招人贴 —— 每条都带地址和
 * 数字，规则没法用时间表达把它们排除，但它们根本不是给用户排期用的。
 *
 * 判据：方括号标签 ≥3 个，或「地址/科目/年级/学员/课时费」这类字段 ≥3 个。
 * 真实的会议通知很少这么密（一般就【时间】【地点】两个）。
 */
function isFormAd(text: string): boolean {
  const tags = text.match(/[【[][^】\]]{1,10}[】\]]/g) || [];
  if (tags.length >= 3) return true;
  // 「【地址】xx 【学科】xx」这种两段式就够判了：正常通知不会用「地址 + 科目」发帖
  const hasAddr = /(地址|上课地点|家教地址)/.test(text);
  const hasRecruit = /(科目|学科|年级|学员|课时费|课时|订单|接单|中介|试课|薪酬|待遇)/.test(text);
  // 有的中介贴不写地址，只写「年级性别科目：六年级男生全科 / 成绩：…」，也要拦住
  const tutorForm = /(年级|学员)[^。\n]{0,12}(科目|性别|成绩)/.test(text);
  return tutorForm || (hasAddr && hasRecruit);
}

export function extractFromChats(files: ChatFile[]): ExtractResult {
  const items: PersonalItem[] = [];
  const fileStats: ExtractResult["files"] = [];
  let scanned = 0;
  let hinted = 0;

  for (const f of files) {
    const { messages, error } = readChatFile(f);
    fileStats.push({ name: f.name, messages: messages.length, error });
    scanned += messages.length;

    for (const msg of messages) {
      const text = msg.text;
      if (isFormAd(text)) continue;
      const date = resolveDate(text, msg.at);
      if (!date) continue;
      hinted++;

      const kind = classify(text);
      if (!kind) continue;

      const time = resolveTime(text);
      const startAt = time
        ? `${dateKey(date)}T${pad(time.h)}:${pad(time.m)}:00+08:00`
        : `${dateKey(date)}T00:00:00+08:00`;

      // 「14:30-16:00」这类区间：补一个结束时间，日历上才画得出时长
      let endAt: string | undefined;
      if (time) {
        const tail = text.match(/[-–—~～至到]\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)/);
        if (tail) {
          const eh = +tail[1];
          const em = +tail[2];
          if (eh > time.h || (eh === time.h && em > time.m)) {
            endAt = `${dateKey(date)}T${pad(eh)}:${pad(em)}:00+08:00`;
          }
        }
      }

      const title = cleanTitle(text);
      if (!title || title.length < 3) continue;

      items.push({
        kind,
        title,
        startAt,
        endAt,
        allDay: !time,
        location: extractLocation(text),
        note: [msg.from ? `来自群：${msg.from}` : null, `原话：${text.slice(0, 60)}`]
          .filter(Boolean)
          .join("｜"),
      });
    }
  }

  return { items, scanned, hinted, files: fileStats };
}

/** 抽出后按「日期+类型+标题」去重，同一条通知被转述多次只留一条 */
export function dedupeItems(items: PersonalItem[]): PersonalItem[] {
  const map = new Map<string, PersonalItem>();
  for (const it of items) {
    const k = `${it.startAt.slice(0, 10)}|${it.kind}|${it.title}`;
    if (!map.has(k)) map.set(k, it);
  }
  return [...map.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}
