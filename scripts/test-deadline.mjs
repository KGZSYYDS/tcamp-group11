/**
 * 截止抽取回归用例。
 *
 * 这些例子都是从真实公文通里挑出来的「踩过的坑」，不是编的：
 *   - 报名截止 11/9 10:00（最常见，带具体钟点）
 *   - 「请于 11 月 20 日前将材料发送至邮箱」（「前」和动词之间夹着宾语）
 *   - 「报名时间：A—B」取 B（不能取审核结果的日期）
 *   - 「下午 5:30」不能被当成凌晨 05:30
 *   - 「11 月 10 日至 12 日停电检修」不是截止（时间段 ≠ 截止）
 *   - 「报名截止后…」是叙述，不是截止时间
 *
 * 用法：npm run test:deadline
 */
import { extractDeadline, isFacultyDeadline, isActionableDeadline } from "../lib/deadline.mjs";

const cases = [
  ["报名截止时间：2026年11月9日10:00，先报先得", "2026-11-05", "2026-11-09", "10:00"],
  ["请于11月20日前将材料发送至邮箱", "2026-11-05", "2026-11-20", null],
  ["报名时间：11月16日9:00—11月29日17:30", "2026-11-05", "2026-11-29", "17:30"],
  ["截止时间：2026年11月16日（星期一）下午5:30前", "2026-11-05", "2026-11-16", "17:30"],
  ["11月10日至11月12日停电检修", "2026-11-05", null, null],
  ["报名截止后，学院开展审核", "2026-11-05", null, null],
  ["截止时间为2026年11月8日17:00", "2026-11-05", "2026-11-08", "17:00"],
  ["部赛报名时间：截止2026年11月9日中午12:00", "2026-11-05", "2026-11-09", "12:00"],
  ["请于11月20日前后关注公众号", "2026-11-05", null, null],
];

let pass = 0;
const fails = [];
for (const [text, pub, wantDate, wantTime] of cases) {
  const got = extractDeadline(text, pub);
  const ok = (got?.date ?? null) === wantDate && (got?.time ?? null) === wantTime;
  if (ok) pass++;
  else fails.push(`${text}\n     期望 ${wantDate ?? "null"} ${wantTime ?? "-"}，实际 ${got ? got.date + " " + (got.time || "-") : "null"}`);
}

// 教师向 / 非待办：这两类不该进学生的日历
const filters = [
  ["关于组织申报国家重点研发计划项目的通知", true],
  ["关于举办全国大学生职业规划大赛院赛的通知", false],
  ["2026年度教育部-华为优秀教师教材奖励计划申报通知", true],
  ["关于校级学生工作品牌项目中期考核及结项验收的通知", true],
  ["关于2025-2026学年管理学院学生会工作人员考核评议结果的公示", true],
];
for (const [title, want] of filters) {
  const got = isFacultyDeadline(title, "") || !isActionableDeadline(title);
  if (got === want) pass++;
  else fails.push(`过滤判断：${title}\n     期望 ${want}，实际 ${got}`);
}

const total = cases.length + filters.length;
console.log(`\n${pass}/${total} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("抽取器与过滤器全部通过\n");
