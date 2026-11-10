/**
 * 相关性打分。
 *
 * 原来只有「留 / 筛掉」两种结果，且 scope=school 一律保留，所以「仅看相关」形同虚设：
 * 636 条公共通知里绝大多数被批量标成了全校。
 *
 * 这里改成一个 0–100 的分数，信号全部来自已有字段，不改数据库、不改采集：
 *   结构（scope 与画像的匹配） + 正文里的学院/专业/年级/课程名 + 类型权重 + 时效 + 完整度
 *
 * 分数有两个用途：
 *   1. 「仅看相关」按阈值筛，而不是只看 scope
 *   2. 同一天内的排序，先看得分高的
 */

/** 低于这个分数，「仅看相关」就把它收起来 */
export const RELATED_THRESHOLD = 45;

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

/** 去掉空格再比，避免「2024 级」与「2024级」对不上 */
function norm(value) {
  return String(value ?? "").replace(/[\s\u3000]+/g, "");
}

/**
 * @param {{kind:string,title:string,note?:string,scope?:string,college?:string,grade?:string,at:Date,allDay?:boolean,location?:string}} input
 * @param {{college?:string,major?:string,grade?:string,level?:string,courses?:string[]}} viewer
 * @param {Date} [now]
 * @returns {{score:number,reasons:string[],related:boolean}}
 */
export function scoreEvent(input, viewer, now = new Date()) {
  const scope = input.scope || "school";
  const reasons = [];

  // 个人数据天然 100 分
  if (scope === "personal") return { score: 100, reasons: ["仅自己"], related: true };

  const text = norm(`${input.title} ${input.note ?? ""}`);
  const college = norm(viewer.college);
  const major = norm(viewer.major);
  const grade = norm(viewer.grade);
  const level = viewer.level || "undergraduate";

  // 基础分：定向通知本来就比全校通知更可能相关
  let score = scope === "school" ? 35 : 55;
  reasons.push(scope === "school" ? "全校通知" : "定向通知");

  // ---- 结构匹配 ----
  if (scope === "college") {
    if (!college) {
      /* 画像缺学院就不动分，交给正文信号 */
    } else if (norm(input.college) === college) {
      score += 25;
      reasons.push("你所在学院");
    } else {
      score -= 45;
      reasons.push("非你所在学院");
    }
  } else if (scope === "grade") {
    if (!grade) {
      /* 缺年级不判 */
    } else if (norm(input.grade) === grade) {
      score += 20;
      reasons.push("你所在年级");
    } else {
      score -= 45;
      reasons.push("非你所在年级");
    }
  } else if (scope === "undergraduate" || scope === "postgraduate" || scope === "doctoral") {
    if (scope === level) {
      score += 15;
      reasons.push(`面向${LEVEL_SCOPE[scope] ?? "本层次"}`);
    } else {
      score -= 45;
      reasons.push("非你所在培养层次");
    }
  }

  // ---- 正文信号：批量入库全标 school 时，这是唯一能救回来的线索 ----
  if (college && text.includes(college)) {
    score += 20;
    reasons.push("标题提到你所在学院");
  }
  if (major && text.includes(major)) {
    score += 10;
    reasons.push("标题提到你的专业");
  }
  if (grade && (text.includes(grade) || text.includes(grade.replace(/级$/, "")))) {
    score += 10;
    reasons.push("标题提到你的年级");
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

  // 能报名的（面向全校但谁都能参加）比纯资讯更值得看。
  // 不加这一条，创业园申报、学科竞赛这类会卡在 44 分，差一分被筛掉。
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
  return { score: clamped, reasons, related: clamped >= RELATED_THRESHOLD };
}

/** 同一列表内的排序：分数高的在前，同分按时间近的在前 */
export function compareRelevance(a, b) {
  return b.score - a.score || a.at.getTime() - b.at.getTime();
}
