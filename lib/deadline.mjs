/**
 * 从一段通知正文里抽出「截止时间」。
 *
 * 为什么单独抽：公文通的正文里到处是「11月9日 10:00 报名截止」「请于11月20日前提交」，
 * 但原来的入库逻辑只按标题关键词分类，时间取的是「正文里第一个出现的日期」——
 * 那多半是活动开始时间，甚至可能是发布日期。真正的截止时间被丢掉了，
 * 于是日历上一堆「讲座/答辩」，却没有一条「什么时候之前要交」。
 *
 * 抽取策略（从强到弱）：
 *   1. 截止/截至 + 紧邻日期时间       「报名截止时间：2026年11月9日10:00」
 *   2. 日期紧跟「前」                 「请于11月20日前将材料发送至邮箱」
 *   3. 固定词组                       「…前提交 / 前发送」
 *   4. 时间段 A 至 B，取 B            「报名时间：11月1日至11月9日」
 *
 * 时间缺失时按语义补：带「前」的取当天 23:59（那一天结束前）；
 * 其余取 23:59 也在所难免，但会标记 precision，避免把 00:00 当成真截止。
 */

const PAD = (n) => String(n).padStart(2, "0");

/** 中文数字转数值，只覆盖 1–31（日期用得到） */
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (s.length === 1 && CN[s]) return CN[s];
  return null;
}

const NUM = "(\\d{1,2}|[一二三四五六七八九十]{1,3})";

/** 日期：2026年11月9日 / 11月9日 / 2026-11-09 / 11.9 */
function findDates(text) {
  const out = [];
  const push = (idx, y, mo, d, raw) => {
    const month = cnNum(mo), day = cnNum(d);
    if (!month || !day || month > 12 || day > 31) return;
    out.push({ idx, year: y ? Number(y) : null, month, day, raw });
  };

  let m;
  const re1 = new RegExp(`(20\\d{2})\\s*[年\\-/.]\\s*${NUM}\\s*[月\\-/.]\\s*${NUM}\\s*日?`, "g");
  while ((m = re1.exec(text))) push(m.index, m[1], m[2], m[3], m[0]);

  const re2 = new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日号]`, "g");
  while ((m = re2.exec(text))) {
    // 被 re1 完全覆盖的跳过（带年份那种）
    if (out.some((o) => m.index >= o.idx && m.index < o.idx + o.raw.length)) continue;
    push(m.index, null, m[1], m[2], m[0]);
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/** 时间：10:00 / 下午5:30 / 中午12点 / 下午3点半 / 上午十点 */
function findTime(str) {
  // HH:MM 形式。前面可能带「下午/晚上」，直接取 05:30 会把下午 5 点算成凌晨。
  let m = str.match(/(上午|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) {
    let h = Number(m[2]);
    const mi = Number(m[3]);
    const period = m[1] || "";
    if ((period === "下午" || period === "晚上" || period === "傍晚") && h < 12) h += 12;
    if (period === "中午" && h < 11) h += 12;
    if (h <= 24 && mi < 60) return h === 24 ? "23:59" : `${PAD(h)}:${PAD(mi)}`;
  }
  m = str.match(/(上午|中午|下午|晚上|傍晚)?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[点時时](半|(\d{1,2})\s*分)?/);
  if (m) {
    let h = cnNum(m[2]);
    if (h == null) return null;
    const period = m[1] || "";
    if ((period === "下午" || period === "晚上" || period === "傍晚") && h < 12) h += 12;
    if (period === "中午" && h < 11) h += 12;
    const mi = m[3] === "半" ? 30 : m[4] ? Number(m[4]) : 0;
    if (h <= 23 && mi < 60) return `${PAD(h)}:${PAD(mi)}`;
  }
  return null;
}

const DDL_WORDS = [
  "报名截止时间", "报名截止", "提交截止时间", "截止时间", "截止日期", "截止至", "截止到",
  "截止", "截至", "申报截止", "申请截止",
];
const BEFORE_WORDS = ["前提交", "前完成", "前报名", "前报送", "前发送", "前上传", "前反馈", "之前提交", "之前完成", "前交"];
/** 三级：只有写了「报名/申请/提交时间：A 至 B」才把 B 当截止 */
const RANGE_LEADS = ["报名时间", "申请时间", "提交时间", "征集时间", "受理时间", "申报时间", "报名日期", "截止日期"];

/** 「截止后」「截止前3个工作日」是叙述，不是截止时间定义，跳过 */
const NARRATIVE = /^(之)?(后|前\s*[\d一二三四五六七八九十]|前，)/;

/**
 * @param {string} content 正文
 * @param {string} publishedAt 发布日期 YYYY-MM-DD，用于补全年份
 * @returns {{date:string, time:string|null, expected:boolean, phrase:string}|null}
 */
export function extractDeadline(content, publishedAt) {
  const text = String(content || "").replace(/\s+/g, " ");
  if (!text) return null;

  const pubYear = /^\d{4}/.test(publishedAt || "") ? Number(publishedAt.slice(0, 4)) : new Date().getFullYear();
  const dates = findDates(text);
  if (!dates.length) return null;

  const toAbs = (d) => {
    const y = d.year || pubYear;
    return { ...d, abs: `${y}-${PAD(d.month)}-${PAD(d.day)}` };
  };

  // 1) 截止类关键词 + 后方 60 字内的第一个日期（关键词前 20 字内也算）
  for (const w of DDL_WORDS) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      from = i + w.length;

      const tail = text.slice(i + w.length, i + w.length + 8);
      if (NARRATIVE.test(tail)) continue;

      const window = text.slice(Math.max(0, i - 20), i + 60);
      const after = dates.filter((d) => d.idx >= i && d.idx < i + 60).map(toAbs);
      if (after.length) {
        const d = after[0];
        return { date: d.abs, time: findTime(text.slice(d.idx, d.idx + 30)) || findTime(window), expected: true, phrase: window.slice(0, 50) };
      }
      const before = dates.filter((d) => d.idx < i && d.idx >= i - 20).map(toAbs);
      if (before.length) {
        const d = before[before.length - 1];
        return { date: d.abs, time: findTime(window), expected: true, phrase: window.slice(0, 50) };
      }
    }
  }

  // 2) 「日期 + 前」：日期紧跟着「前」，就是那天之前。
  //    比固定词组（前提交/前发送）稳，因为「请于11月20日前将材料发送至邮箱」中间
  //    还夹着「将材料」三个字，词组匹配不到。排除「前后」——那是范围不是截止。
  for (const d of dates) {
    const abs = toAbs(d);
    const tail = text.slice(d.idx + d.raw.length, d.idx + d.raw.length + 5);
    if (!/^\s*(之)?前(?!后)/.test(tail)) continue;
    const head = text.slice(Math.max(0, d.idx - 25), d.idx);
    return {
      date: abs.abs,
      time: findTime(text.slice(d.idx, d.idx + 24)) || findTime(head),
      expected: true,
      phrase: (head + text.slice(d.idx, d.idx + 24)).slice(-50),
    };
  }

  // 3) 「于…前提交/完成」这类固定词组
  for (const w of BEFORE_WORDS) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(w, from);
      if (i < 0) break;
      from = i + w.length;
      const before = dates.filter((d) => d.idx < i && d.idx > i - 40).map(toAbs);
      if (before.length) {
        const d = before[before.length - 1];
        return {
          date: d.abs,
          time: findTime(text.slice(Math.max(0, i - 30), i + 10)),
          expected: true,
          phrase: text.slice(Math.max(0, i - 30), i + w.length),
        };
      }
    }
  }

  // 4) 「报名时间：11月1日至11月9日」——必须带这类前缀，否则「11月10日至12日停电」
  //    这种施工/活动期间也会被当成截止日期，实测就是这么误收的。
  //    只取前缀后第一句：一份通知里常连着写「申请时间」「审核结果时间」两段，
  //    取整段会把后面那个更大的日期当成截止（辅修通知就栽在这）。
  for (const lead of RANGE_LEADS) {
    const i = text.indexOf(lead);
    if (i < 0) continue;
    const seg = text.slice(i, i + 80);
    if (!/[至到—~]/.test(seg)) continue;
    const first = seg.split(/[。；;\n]/)[0];
    const abs = findDates(first).map(toAbs);
    if (abs.length >= 2) {
      const last = abs[abs.length - 1];
      const time = findTime(first.slice(last.idx, last.idx + 24)) || "23:59";
      return { date: last.abs, time, expected: true, phrase: first.slice(0, 50) };
    }
  }

  return null;
}

/**
 * 老师/科研人员才用得上的截止（申报项目、结项、招标），对学生是纯噪音。
 * 只按标题判断，宁可漏掉教师类，也不要把学生的报名截止误杀。
 */
const FACULTY_ONLY =
  /申报|结项|招标|采购|项目验收|项目立项|年度检查|课题|科研经费|科研仪器|科研设备|基金项目|基金委|自然科学基金|社科基金|社科规划|教育科学规划|重点研发计划|科技厅|专利|征求意见/;
const FACULTY_TITLE = /教师|师资|教工|党支部书记|博导|导师资格|继续教育|职称|人才引进|教学名师|教材奖励|教学成果奖|青年教师/;
/** 标题里带「学生」不代表发给学生 ——「学生工作品牌项目」是学工线老师的活 */
const FACULTY_STRONG = /学生工作品牌|辅导员|班主任|学工干部|学院副书记|博士研究生|博士生/;
const STUDENT_SIGNAL = /学生|同学|本科生|研究生|奖学金|助学金|竞赛|大赛|报名|体测|选课|考试|实习|招聘|评优|三好|班级|学院学生/;

export function isFacultyDeadline(title, content) {
  const t = String(title || "");
  if (FACULTY_STRONG.test(t)) return true;
  if (STUDENT_SIGNAL.test(t)) return false;
  if (FACULTY_TITLE.test(t)) return true;
  // 「申报/结项/专利」这类词出现在标题里，基本就能定性为教师或科研口；
  // 学生的申报一定带「学生/大赛/项目」等学生信号，上面已经短路了。
  return FACULTY_ONLY.test(t);
}

/** 不是「要做的事」的截止：数据库试用到期、场地临时占用、结果/名单公布这类 */
const NOT_A_TODO = /试用库|试用至|数据库试用|停水|停电|施工|维修|封闭|公示|公布/;
export function isActionableDeadline(title) {
  return !NOT_A_TODO.test(String(title || ""));
}

/** 供调试：把正文里识别到的日期/时间打出来 */
export function debugDates(content) {
  return { dates: findDates(String(content || "")), time: findTime(String(content || "")) };
}

/**
 * 备注里有没有写明确的钟点。
 *
 * 采集器为了让截止能排序，把「只写了日期」的截止统一补成当天 23:59（见文件头）。
 * 那个 23:59 是排序值，原文里并没有这个时刻——UI 照直显示，学生会以为
 * 通知真的写了「23:59 截止」，据此安排提交时间就会误事。
 *
 * 手填 / 畅课同步 / 群聊的备注没有「截止：」前缀，时间是用户自己选的，一律算准确。
 *
 * @param {string | null | undefined} note
 * @returns {boolean}
 */
export function hasExplicitClock(note) {
  // 先剥掉栏目标注那一行，采集器写的备注一定以「截止：」开头
  const text = String(note || "").replace(/^\[board-taxonomy-v1:[a-z_]+:[a-z_-]+\]\s*/, "");
  if (!/^截止[:：]/.test(text)) return true;
  return /^截止[:：]\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(text);
}

/**
 * 备注里与卡片上方重复的部分剥掉，只留下真正有信息量的「原话」。
 *
 *   「[board-taxonomy-v1:…]\n截止：2026-11-12 18:00｜原话：…｜发布：教务部」
 *   → 「原话：…」
 *
 * 截止时间、栏目、发布单位都已经在卡片上单独展示了，备注再重复一遍只是噪音。
 *
 * @param {string | null | undefined} note
 * @returns {string}
 */
export function stripDeadlinePrefix(note) {
  return String(note || "")
    .replace(/^\[board-taxonomy-v1:[a-z_]+:[a-z_-]+\]\s*/, "")
    .replace(/^截止[:：][^｜|]*(?:[｜|]\s*)?/, "")
    .replace(/^来自群[:：][^·｜|]*(?:[·｜|]\s*)?/, "")
    .replace(/[｜|]\s*发布[:：][^｜|]*$/, "")
    .trim();
}
