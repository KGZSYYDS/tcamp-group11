/**
 * 相关性打分回归用例。
 *
 * 重点验证「批量入库全标 school」这个现实前提下，靠标题能不能把通知捞回来：
 *   - 标题写着你所在学院的全校通知，分数要过线
 *   - 什么信号都没有的全校通知，分数要掉在线下
 *   - 明确标了别的学院/别的层次，必须被压下去
 *
 * 用法：node scripts/test-relevance.mjs
 */
import { scoreEvent, compareRelevance, RELATED_THRESHOLD } from "../lib/relevance.mjs";

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
  cases.push(["标题含本学院 → 相关", r.related && r.score >= RELATED_THRESHOLD, r]);
  cases.push(["给出「标题提到你所在学院」理由", r.reasons.includes("标题提到你所在学院"), r]);
}

// 2. 全校通知，毫无信号、还在一个月后 → 应该被筛掉
{
  const r = run(mk({ at: at(60) }));
  cases.push(["无信号的全校通知 → 不相关", !r.related, r]);
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

// 5. 年级匹配 / 不匹配
{
  const ok = run(mk({ scope: "grade", grade: "2024 级", at: at(1) }));
  const bad = run(mk({ scope: "grade", grade: "2023 级", at: at(1) }));
  cases.push(["同年级定向 → 相关", ok.related, ok]);
  cases.push(["跨年级定向 → 不相关", !bad.related, bad]);
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

// 8. 已过期要压下去
{
  const r = run(mk({ kind: "exam", at: at(-10) }));
  cases.push(["过期的考试通知 → 不相关", !r.related, r]);
}

// 9. 个人事件恒为满分
{
  const r = run(mk({ scope: "personal", at: at(-100) }));
  cases.push(["个人事件 → 100 分", r.score === 100 && r.related, r]);
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
