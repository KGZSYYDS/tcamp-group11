/**
 * 活动时间择一回归用例。
 *
 * 用例全部来自公文通真实写法，不是编的：
 *   - 印发日期写在正文开头，活动时间在后面
 *   - 报名截止和活动时间同时出现
 *   - 只有截止、没有活动（不该生成活动行）
 *   - 时间段取开始日
 *   - 跨年（12 月发通知说 1 月的事）
 *
 * 用法：node scripts/test-parse-time.mjs
 */
import { pickEventTime, debugTimes } from "../lib/parse-time.mjs";

const cases = [
  [
    "根据《深大校〔2026〕1号》（2026年11月8日印发），本学期期末考试定于12月28日举行。",
    "2026-11-08",
    "2026-12-28",
    null,
  ],
  ["报名截止11月9日10:00，活动11月20日19:00开始", "2026-11-05", "2026-11-20", "19:00"],
  ["讲座时间：11月20日（周四）19:00", "2026-11-05", "2026-11-20", "19:00"],
  ["请于11月20日前将材料发送至邮箱", "2026-11-05", null, null],
  ["2026年12月28日（星期一）上午9:30在第一教学楼", "2026-11-05", "2026-12-28", "09:30"],
  ["11月10日至11月12日停电检修", "2026-11-05", "2026-11-10", null],
  ["现将有关事项通知如下：报名截止11月9日10:00", "2026-11-05", null, null],
  [
    "定于2026年11月21日（周六）上午8:00—12:00在元平体育场进行体质测试",
    "2026-11-07",
    "2026-11-21",
    "08:00",
  ],
  ["报名截止1月5日，讲座定于1月8日19:00", "2026-12-20", "2027-01-08", "19:00"],
  ["2026年11月15日下午5:30在文科楼开会", "2026-11-05", "2026-11-15", "17:30"],
  // 时间段取开始，不能取结束
  ["讲座时间：11月20日（周五）上午10-11点", "2026-11-05", "2026-11-20", "10:00"],
  // 详情页页脚的「更新于」不是活动时间
  ["正文内容若干。\n更新于 2026-11-06 20:32", "2026-11-06", null, null],
];

let pass = 0;
const fails = [];

for (const [text, pub, wantDate, wantTime] of cases) {
  const got = pickEventTime(text, pub);
  const wantFound = wantDate !== null;
  const ok =
    got.found === wantFound &&
    got.date === (wantDate ?? pub) &&
    (got.time ?? null) === (wantTime ?? null);

  if (ok) {
    pass++;
  } else {
    fails.push(
      `  ${text}\n     期望 found=${wantFound} ${wantDate ?? pub} ${wantTime ?? "-"}` +
        `\n     实际 found=${got.found} ${got.date} ${got.time ?? "-"}` +
        `\n     打分 ${JSON.stringify(debugTimes(text, pub))}`
    );
  }
}

console.log(`活动时间择一：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败用例：");
  for (const line of fails) console.log(line);
  process.exit(1);
}

// 抽一条展示打分过程，便于以后调参
const sample = "根据《深大校〔2026〕1号》（2026年11月8日印发），本学期期末考试定于12月28日举行。";
console.log("\n打分示例：");
for (const row of debugTimes(sample, "2026-11-08")) {
  console.log(
    `  ${row.date} ${row.time ?? "--:--"}  ${String(row.score).padStart(2)} 分  [${row.reasons.join("、")}]  ${row.context}`
  );
}
