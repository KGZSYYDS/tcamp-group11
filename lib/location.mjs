/**
 * 从通知正文里抽地点。
 *
 * 背景：events.location 636 行只有 7 行有值——入库脚本从来没写过这个字段，
 * 正文里的「地点：致理楼201」被当成简介截进 note 前 300 字。而 note 只留 300 字，
 * 采集到的正文 95% 超过 300 字，靠 note 重抽会丢一大半，所以必须从 content 全文抽。
 *
 * 三层，命中即返回：
 *   1. 标注式「讲座地点：xxx」——最准，优先
 *   2. 线上会议「腾讯会议 494 342 964」——归一化成 3-3-3
 *   3. 叙述式「在文科楼H3-102举行」——兜底，要求带楼/室/厅等锚点
 *
 * 纯函数，不 import node 内置模块（前端也要用）。
 */

/** 判定「像地点」的锚点词 */
const ANCHOR_RE = /(楼|室|厅|馆|校区|中心|教室|广场|栋|座|苑|斋|礼堂|层|院)/;
/** 房号形态：A6-606 / L3-404 / H-05 / 汇文楼2112 */
const ROOM_RE = /[A-Za-z]{1,2}\d{0,4}[-－—]\d{1,4}|\d{3,4}\s*室/;
/** 线上会议标识 */
const ONLINE_RE = /腾讯会议|会议号|会议\s*ID|voov|zoom/i;
/** 叙述动线，不是活动地点 */
const NARRATIVE_BAD_RE = /参观|走访|调研|考察|前往|赴|参访|乘车|就餐|动线|老师|同学|专家|领导|教授|主任|院长|人员/;
/** 过泛值 */
const TOO_GENERIC_RE = /^(深圳大学|粤海校区|丽湖校区|沧海校区|深圳大学.{0,8}校区)[。.;；]?$/;
/** 纯日期 / 纯时间，绝不能当地点 */
const DATE_ONLY_RE = /^\d{4}\s*年|^\d{1,2}\s*[:：]\s*\d{2}/;

/** 标注词：强标签排前面（一份通知里常同时有「活动地点」和「异议送交地址」） */
const LABELS = [
  "讲座地点", "活动地点", "举办地点", "报告地点", "答辩地点", "上课地点",
  "会议地点", "培训地点", "面试地点", "签到地点", "集合地点", "授课地点",
  "主会场", "分会场", "地 点", "地点", "地址", "场所", "Venue",
];

/** 去掉尾部的句号、多余括号、课序号注释 */
function tidy(raw) {
  let v = String(raw || "").trim();
  if (!v) return null;

  // 去掉「课序号36」这类注释
  v = v.replace(/[（(]\s*课序号[^）)]*[）)]/g, "");
  // 截到句末标点
  v = v.split(/[。；;！!？?]/)[0].trim();
  // 去掉行内多余空白
  v = v.replace(/[\t \u3000]+/g, " ").trim();
  // 去掉包裹的括号 / 书名号：只剥不成对的，别把「（汇昀楼305）」拆坏
  v = v.replace(/^[（(《【\[]+/, "").trim();
  if (!/[（(]/.test(v)) v = v.replace(/[）)》】\]]+$/, "").trim();
  // 去掉前导日期与时段
  v = v.replace(/^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*/, "");
  v = v.replace(/^\d{1,2}\s*[:：]\s*\d{2}\s*[-—~至]\s*\d{1,2}\s*[:：]\s*\d{2}\s*/, "");
  // 去掉尾部残留的「时间/日期」
  v = v.replace(/[，,、]\s*(时间|日期)\s*[:：].*$/, "").trim();

  if (!v) return null;
  return v;
}

/** 这个值像不像一个地点 */
export function isLikelyLocation(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.length < 3 || v.length > 40) return false;
  if (DATE_ONLY_RE.test(v)) return false;
  if (TOO_GENERIC_RE.test(v)) return false;
  if (NARRATIVE_BAD_RE.test(v)) return false;
  if (ONLINE_RE.test(v)) return false; // 线上走单独分支
  return ANCHOR_RE.test(v) || ROOM_RE.test(v);
}

/** 会议号归一化：494 342 964 → 494-342-964 */
function normalizeMeetingNumber(digits) {
  const d = String(digits).replace(/\D/g, "");
  if (d.length < 6) return null;
  const chunks = [];
  let rest = d;
  while (rest.length > 4) {
    chunks.push(rest.slice(0, 3));
    rest = rest.slice(3);
  }
  if (rest) chunks.push(rest);
  return chunks.join("-");
}

/** 整篇里找线上会议室 */
function findOnline(text) {
  const head = /(?:腾讯会议|会议号|会议\s*ID|voov)[^0-9]{0,12}/i;
  const idx = head.exec(text);
  if (idx) {
    const tail = text.slice(idx.index + idx[0].length).replace(/^[^\d]+/, "");
    // 先认 3-3-3 / 3-3-4 的标准写法，避免把后面第二个号码一起吃掉
    const m = /^(\d{3})[\s\-]?(\d{3})(?:[\s\-]?(\d{3,4}))?/.exec(tail) || /^(\d{9,11})/.exec(tail);
    if (m) {
      const num = normalizeMeetingNumber(m[0]);
      if (num) return { location: `腾讯会议 ${num}`, kind: "online", confidence: 0.9, rule: "online", phrase: idx[0].slice(0, 40) + m[0] };
    }
  }
  const link = /(?:腾讯会议|会议)\s*[:：]?\s*(https?:\/\/meeting\.tencent\.com\/\S+)/i.exec(text);
  if (link) {
    return { location: "腾讯会议（链接）", kind: "online", confidence: 0.75, rule: "online", phrase: link[0].slice(0, 60) };
  }
  return null;
}

/**
 * 从正文抽地点。
 * @param {string} content 通知正文全文（不要传被截断的 note）
 * @returns {{location: string|null, kind: "physical"|"online"|null, confidence: number, rule: "label"|"online"|"narrative"|null, phrase: string}}
 */
export function extractLocation(content) {
  const raw = String(content || "").replace(/\r/g, "");
  if (!raw.trim()) return { location: null, kind: null, confidence: 0, rule: null, phrase: "" };

  // 只压行内空白，保留换行——采集正文是 \n\r\n\r\n 分隔，
  // 一旦把 \s+ 全压成空格，「地点：」会和下一段粘成一个脏值，而且看起来像成功。
  const text = raw
    .replace(/[\t \u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(撰稿|审核|（更新于)\s*[:：]?[\s\S]*$/, "");

  // ---- 第 1 层：标注式 ----
  for (const label of LABELS) {
    const re = new RegExp(label.replace(/ /g, "\\s*") + "\\s*(?:Venue\\s*)?[:：]?", "gi");
    let m;
    while ((m = re.exec(text))) {
      const after = text.slice(m.index + m[0].length);
      // 「时间地点时间：…」——标签后面紧跟时间，跳过
      if (/^\s*(时间|日期|安排)/.test(after)) continue;

      // 取当前位置之后第一段非空内容
      const lines = after.split("\n");
      let value = lines[0].trim();
      if (!value) {
        for (let i = 1; i < lines.length; i += 1) {
          const t = lines[i].trim();
          if (t) {
            value = t;
            break;
          }
        }
      }
      const v = tidy(value);
      if (!v) continue;

      // 标注出来的值本身是线上会议
      if (ONLINE_RE.test(v)) {
        const online = findOnline(v);
        if (online) return online;
        return { location: "线上", kind: "online", confidence: 0.5, rule: "label", phrase: v.slice(0, 60) };
      }
      if (isLikelyLocation(v)) {
        return {
          location: v,
          kind: "physical",
          confidence: 0.95,
          rule: "label",
          phrase: m[0].trim().slice(0, 60),
        };
      }
    }
  }

  // ---- 第 2 层：整篇里的线上会议 ----
  const online = findOnline(text);
  if (online) return online;

  // ---- 第 3 层：叙述式 ----
  const narRe = /(?:在|于)([^。；;，,\n]{0,30}?)(?:举行|召开|举办|开展|开班|开讲|进行)/g;
  let n;
  while ((n = narRe.exec(text))) {
    // 去掉捕获段里前面残留的日期：「2026年11月5日在汇研楼601会议室」
    const seg = n[1].split(/在|于/).pop();
    let v = tidy(seg);
    if (!v) continue;
    // 尾缀清洗
    v = v.replace(/(圆满|成功|顺利|隆重|如期)$/, "").trim();
    if (!v) continue;
    // 叙述式要求更严：必须含锚点词，纯房号不算
    if (ANCHOR_RE.test(v) && isLikelyLocation(v)) {
      return { location: v, kind: "physical", confidence: 0.7, rule: "narrative", phrase: n[0].slice(0, 60) };
    }
  }

  return { location: null, kind: null, confidence: 0, rule: null, phrase: "" };
}
