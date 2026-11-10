/** 学院、培养层次与答辩规则决定是否展示，分数用于排序。 */

const KIND_WEIGHT = {
  deadline: 15,
  ddl: 15,
  exam: 12,
  meeting: 8,
  pe: 6,
  activity: 4,
  checkin: 2,
  other: 0,
};

const LEVEL_SCOPE = {
  undergraduate: "本科生",
  postgraduate: "硕士生",
  doctoral: "博士生",
};

function norm(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "");
}

/**
 * 结构是否匹配。
 * 上层可能已经有更聪明的匹配器（比如 hwb 的 sameAffiliation 能认「计软」↔「计算机与软件」），
 * 传了布尔值就听它的，没传才退回字符串比较。
 */
function isMatched(flag, left, right) {
  if (typeof flag === "boolean") return flag;
  return Boolean(right) && norm(left) === right;
}

const ACADEMIC_AUDIENCE = /学位论文|论文答辩|开题(?:报告|答辩)|中期考核|学位授予|期末考试|课程考试|选退课|选课|体质测试|体测|军训/;
const CAMPUS_DATE = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "numeric",
});

function isSenior(viewer, now) {
  if (viewer.level !== "undergraduate") return false;
  const grade = norm(viewer.grade);
  if (/^(?:大四|(?:本科)?(?:四|4)年级)$/.test(grade)) return true;
  const year = /^(?:20)?(\d{2})(?:级)?$/.exec(grade);
  if (!year) return false;
  const parts = CAMPUS_DATE.formatToParts(now);
  const calendarYear = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const academicYear = month < 9 ? calendarYear - 1 : calendarYear;
  return academicYear - (2000 + Number(year[1])) === 3;
}

function titleLevels(title) {
  const target = /(?:面向|仅限|限于|对象[:：])([^，。；！？]{1,40})/.exec(title)?.[1];
  if (!target && !ACADEMIC_AUDIENCE.test(title)) return [];
  const text = target || title;
  const levels = [];
  if (/本科/.test(text)) levels.push("undergraduate");
  if (/硕士/.test(text)) levels.push("postgraduate");
  if (/博士/.test(text)) levels.push("doctoral");
  if (!levels.length && /研究生/.test(text)) levels.push("postgraduate", "doctoral");
  return levels;
}

/**
 * @param {{kind:string,title:string,note?:string,scope?:string,college?:string,boardSubtype?:string,at:Date,allDay?:boolean,location?:string,collegeMatched?:boolean,titleCollegeMatched?:boolean,schoolWideTitle?:boolean}} input
 * @param {{college?:string,major?:string,grade?:string,level?:string,courses?:string[]}} viewer
 * @param {Date} [now]
 * @returns {{score:number,reasons:string[],related:boolean}}
 */
export function scoreEvent(input, viewer, now = new Date()) {
  const scope = input.scope || "school";
  const reasons = [];

  // 个人数据天然 100 分
  if (scope === "personal") return { score: 100, reasons: ["仅自己"], related: true };

  const title = norm(input.title);
  const text = title + norm(input.note);
  const college = norm(viewer.college);
  const major = norm(viewer.major);
  const level = viewer.level;
  let audienceMismatch = false;

  // 基础分：定向通知本来就比全校通知更可能相关
  let score = scope === "school" ? 35 : 55;
  reasons.push(scope === "school" ? "全校通知" : "定向通知");

  // ---- 结构匹配 ----
  const ownCollegeInTitle = Boolean(college && (input.titleCollegeMatched || title.includes(college)));
  if (scope === "college" && college && input.college) {
    const match = isMatched(input.collegeMatched, input.college, college);
    audienceMismatch = !match;
    score += match ? 25 : -45;
    reasons.push(match ? "你所在学院" : "非你所在学院");
  } else if (!input.schoolWideTitle && input.titleCollegeMatched === false && !ownCollegeInTitle) {
    audienceMismatch = true;
    score -= 25;
    reasons.push("标题指向其他学院");
  }

  if (Object.hasOwn(LEVEL_SCOPE, scope) && level) {
    if (scope === level) {
      score += 15;
      reasons.push(`面向${LEVEL_SCOPE[scope] ?? "本层次"}`);
    } else {
      audienceMismatch = true;
      score -= 45;
      reasons.push("非你所在培养层次");
    }
  } else if (scope === "school") {
    const levels = titleLevels(title);
    if (level && levels.length && !levels.includes(level)) {
      audienceMismatch = true;
      reasons.push("标题指向其他培养层次");
    }
  }
  if ((input.boardSubtype === "thesis_defense" || title.includes("答辩")) && !isSenior(viewer, now)) {
    audienceMismatch = true;
    reasons.push("答辩仅在本科大四显示");
  }

  // ---- 正文信号：批量入库全标 school 时，这是唯一能救回来的线索 ----
  if (ownCollegeInTitle || (college && text.includes(college))) {
    score += 20;
    reasons.push(ownCollegeInTitle ? "标题提到你所在学院" : "正文提到你所在学院");
  }
  if (major && text.includes(major)) {
    score += 10;
    reasons.push("标题提到你的专业");
  }
  const hitCourse = (viewer.courses || []).find(
    (c) => c && norm(c).length >= 2 && text.includes(norm(c))
  );
  if (hitCourse) {
    score += 10;
    reasons.push(`与你修的「${hitCourse}」有关`);
  }

  // ---- 类型权重 ----
  score += KIND_WEIGHT[input.kind] ?? 0;

  // 有明确行动入口的通知优先排序。
  if (/报名|申报|招募|征集|申请|开放/.test(input.title)) {
    score += 8;
    reasons.push("可以报名");
  }

  // ---- 时效 ----
  const days = (input.at.getTime() - now.getTime()) / 86400000;
  if (days < -1) {
    score -= 25;
    reasons.push("已过期");
  } else if (days <= 3) {
    score += 10;
    reasons.push("就在这几天");
  } else if (days <= 7) {
    score += 5;
  } else if (days > 30) {
    score -= 5;
  }

  // ---- 完整度：有钟点、有地点的更容易被执行 ----
  if (!input.allDay) score += 5;
  if (input.location) score += 3;

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, reasons, related: !audienceMismatch };
}

/** 同一列表内的排序：分数高的在前，同分按时间近的在前 */
export function compareRelevance(a, b) {
  return b.score - a.score || a.at.getTime() - b.at.getTime();
}
