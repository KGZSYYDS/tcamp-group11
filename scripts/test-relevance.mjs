/**
 * 画像筛选和排序回归用例。
 *
 * 用法：node scripts/test-relevance.mjs
 */
import { scoreEvent, compareRelevance } from "../lib/relevance.mjs";

const NOW = new Date("2026-11-10T10:00:00+08:00");
const VIEWER = {
  college: "计算机与软件学院",
  major: "",
  grade: "2024 级",
  level: "undergraduate",
  courses: ["高等数学"],
};

function at(days) {
  return new Date(NOW.getTime() + days * 86400000);
}

function mk(over = {}) {
  return {
    kind: "other",
    title: "关于开展某项工作的通知",
    note: "",
    scope: "school",
    at: at(5),
    allDay: true,
    ...over,
  };
}

const cases = [];
const run = (input) => scoreEvent(input, VIEWER, NOW);

// 1. 全校通知，标题提到本学院 → 应该过线
{
  const r = run(mk({ title: "计算机与软件学院2026年秋季专场招聘会" }));
  cases.push(["标题含本学院 → 相关", r.related && r.score >= 55, r]);
  cases.push(["给出「标题提到你所在学院」理由", r.reasons.includes("标题提到你所在学院"), r]);
}

// 2. 无学院限制的通知即使分低也保留
{
  const r = run(mk({ at: at(60) }));
  cases.push(["无信号的全校通知 → 保留、低分", r.related && r.score < 45, r]);
}

// 3. 明确指定本学院且就在这几天 → 接近满分
{
  const r = run(mk({ scope: "college", college: "计算机与软件学院", kind: "deadline", at: at(2) }));
  cases.push(["本学院定向截止 → 高分", r.score >= 85 && r.related, r]);
}

// 4. 明确指定别的学院 → 必须被压下去
{
  const r = run(mk({ scope: "college", college: "医学部", kind: "deadline", at: at(2) }));
  cases.push(["别的学院的定向通知 → 不相关", !r.related, r]);
}

// 5. 普通通知不按年级筛，也不因年级不同改变分数
{
  const ok = run(mk({ scope: "grade", grade: "2024 级", at: at(1) }));
  const bad = run(mk({ scope: "grade", grade: "2023 级", at: at(1) }));
  cases.push(["同年级定向 → 相关", ok.related, ok]);
  cases.push(["跨年级定向 → 相关且同分", bad.related && bad.score === ok.score, bad]);
}

// 6. 培养层次
{
  const ok = run(mk({ scope: "undergraduate", at: at(1) }));
  const bad = run(mk({ scope: "postgraduate", at: at(1) }));
  cases.push(["本科定向 + 本科画像 → 相关", ok.related, ok]);
  cases.push(["研究生定向 + 本科画像 → 不相关", !bad.related, bad]);
}

// 7. 课程名命中
{
  const r = run(mk({ title: "《高等数学A(1)》第四次线下见面课", kind: "activity", at: at(2) }));
  cases.push(["标题含所修课程 → 相关", r.related, r]);
}

// 8. 时间用于排序，历史通知仍可查
{
  const r = run(mk({ kind: "exam", at: at(-10) }));
  cases.push(["过期的考试通知 → 保留、低分", r.related && r.score < 45, r]);
}

// 9. 个人事件恒为满分
{
  const r = run(mk({ scope: "personal", at: at(-100) }));
  cases.push(["个人事件 → 100 分", r.score === 100 && r.related, r]);
}

{
  const hot = { kind: "exam", at: at(0), allDay: false, location: "教学楼" };
  const casesForAudience = [
    ["热门的跨学院定向通知仍隐藏", { ...hot, scope: "college", college: "医学部", title: "高等数学考试报名" }, false],
    ["全校入库的硕士考试对本科生隐藏", { ...hot, title: "2024级硕士研究生期末考试安排" }, false],
    ["全校入库的其他年级本科考试保留", { ...hot, title: "2026级本科生期末考试安排" }, true],
    ["旧的本学院普通通知依然显示", { titleCollegeMatched: true, at: at(-100) }, true],
    ["没有特殊关键词的外院通知也隐藏", { ...hot, title: "物理与光电工程学院就业座谈会", titleCollegeMatched: false }, false],
    ["博士作讲者不代表仅面向博士生", { ...hot, kind: "activity", title: "博士主讲的公开学术报告" }, true],
    ["外院承办的全校活动保留", { ...hot, kind: "activity", title: "医学部面向全校开放报名", titleCollegeMatched: false, schoolWideTitle: true }, true],
  ];
  for (const [name, input, expected] of casesForAudience) {
    const result = run(mk(input));
    cases.push([name, result.related === expected, result]);
  }
}

{
  const defense = mk({ title: "计算机与软件学院本科毕业论文答辩安排", at: at(2) });
  const boundary = new Date("2026-09-01T00:00:00+08:00");
  const checks = [
    ["2024 级在 2026 年 11 月是大三，隐藏答辩", defense, VIEWER, NOW, false],
    ["2023 级在 2026 年 11 月是大四，显示本学院答辩", defense, { ...VIEWER, grade: "2023 级" }, NOW, true],
    ["支持全角短年级", defense, { ...VIEWER, grade: "２３ 级" }, NOW, true],
    ["支持直接填大四", defense, { ...VIEWER, grade: "大四" }, NOW, true],
    ["未知年级不显示答辩", defense, { ...VIEWER, grade: "" }, NOW, false],
    ["研究生画像不按本科大四显示答辩", defense, { ...VIEWER, grade: "2023级", level: "postgraduate" }, NOW, false],
    ["云端答辩标签可识别不含关键词的标题", { ...defense, title: "本科毕业考核安排", boardSubtype: "thesis_defense" }, VIEWER, NOW, false],
    ["进入大四前一刻仍隐藏", defense, { ...VIEWER, grade: "23级" }, new Date(boundary.getTime() - 1), false],
    ["按北京时间进入大四后显示", defense, { ...VIEWER, grade: "23级" }, boundary, true],
  ];
  for (const [name, event, viewer, now, expected] of checks) {
    const result = scoreEvent(event, viewer, now);
    cases.push([name, result.related === expected, result]);
  }
}

// 10. 排序：分高的在前，同分按时间近的在前
{
  const list = [
    { score: 40, at: at(1) },
    { score: 80, at: at(9) },
    { score: 40, at: at(0) },
  ].sort(compareRelevance);
  const ok = list[0].score === 80 && list[1].at < list[2].at;
  cases.push(["同分按时间、高分优先", ok, { score: 0, reasons: [list.map((x) => x.score).join(",")] }]);
}

let pass = 0;
const fails = [];
for (const [name, ok, result] of cases) {
  if (ok) pass += 1;
  else fails.push(`${name}\n     实际 ${result.score} 分 [${result.reasons.join("、")}]`);
}

console.log(`相关性打分：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}

console.log("\n打分示例：");
for (const [title, input] of [
  ["本学院招聘会", mk({ title: "计算机与软件学院2026年秋季专场招聘会" })],
  ["无信号通知", mk({ at: at(60) })],
  ["别的学院截止", mk({ scope: "college", college: "医学部", kind: "deadline", at: at(2) })],
]) {
  const r = scoreEvent(input, VIEWER, NOW);
  console.log(`  ${String(r.score).padStart(3)} 分  ${title}  [${r.reasons.join("、")}]`);
}
