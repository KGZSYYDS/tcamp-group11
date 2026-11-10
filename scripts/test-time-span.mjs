/**
 * 时间跨度回归用例：结束时间、日期区间、多时段、时长。
 *
 * 之前的解析只看「哪一天、几点开始」，结束时间一律丢弃，前端按 +60 分钟兜底，
 * 所以「14:00-17:30」的三小时讲座在日历上只有一小时高。
 *
 * 用法：node scripts/test-time-span.mjs
 */
import { pickEventTime, readRanges, readEndDate } from "../lib/parse-time.mjs";

const PUB = "2026-11-10";
const cases = [];
const add = (name, text, expect) => cases.push([name, text, expect]);

/* ---- 单段：起止都要有 ---- */
add("标准时间段", "讲座时间：2026年11月12日（周四）14:00—17:30", {
  date: "2026-11-12",
  time: "14:00",
  endTime: "17:30",
  endDate: null,
});

add("晚上时段", "2026年11月13日晚上19:00-21:00 举行讲座", {
  date: "2026-11-13",
  time: "19:00",
  endTime: "21:00",
  endDate: null,
});

add("九点写法", "2026年11月14日上午9点-11点 开放参观", {
  date: "2026-11-14",
  time: "09:00",
  endTime: "11:00",
  endDate: null,
});

/* ---- 多段：一天里分上下午 ---- */
add("上下午两段", "2026年11月12日 8:30-12:00、14:00-17:30 报到", {
  sessions: [
    { date: "2026-11-12", start: "08:30", end: "12:00" },
    { date: "2026-11-12", start: "14:00", end: "17:30" },
  ],
});

add("上午下午分写", "活动时间：11月13日 上午9:00-11:30 下午14:00-16:30", {
  sessions: [
    { date: "2026-11-13", start: "09:00", end: "11:30" },
    { date: "2026-11-13", start: "14:00", end: "16:30" },
  ],
});

/* ---- 日期区间：跨天 ---- */
add("同月区间", "活动时间：2026年11月12日至14日，地点：致理楼", {
  date: "2026-11-12",
  endDate: "2026-11-14",
});

add("跨月区间", "展览将于2026年12月30日至1月3日在图书馆举行", {
  date: "2026-12-30",
  endDate: "2027-01-03",
});

/* ---- 时长推算 ---- */
add("时长两小时", "讲座于11月15日14:00开始，时长约2小时", {
  date: "2026-11-15",
  time: "14:00",
  endTime: "16:00",
});

add("持续九十分钟", "培训11月16日9:30开始，持续90分钟", {
  date: "2026-11-16",
  time: "09:30",
  endTime: "11:00",
});

/* ---- 只有开始、没有结束 ---- */
add("单点时间不编造结束", "会议定于2026年11月17日15:00召开", {
  date: "2026-11-17",
  time: "15:00",
  endTime: null,
});

/* ---- 非活动：只有截止 ---- */
add("只有截止不产生活动", "请于2026年11月20日前将材料提交至学院办公室", {
  found: false,
});

/* ---- 工具函数 ---- */
const rangeCases = [
  ["单段", "14:00-17:30", [{ start: "14:00", end: "17:30" }]],
  ["多段", "8:30-12:00、14:00-17:30", [
    { start: "08:30", end: "12:00" },
    { start: "14:00", end: "17:30" },
  ]],
  ["反向不取", "23:00-01:00", []],
];

let pass = 0;
const fails = [];

for (const [name, text, expect] of cases) {
  const got = pickEventTime(text, PUB);
  const checks = [];

  if ("found" in expect) checks.push(["found", got.found, expect.found]);
  if ("date" in expect) checks.push(["date", got.date, expect.date]);
  if ("time" in expect) checks.push(["time", got.time ?? null, expect.time]);
  if ("endTime" in expect) checks.push(["endTime", got.endTime ?? null, expect.endTime]);
  if ("endDate" in expect) checks.push(["endDate", got.endDate ?? null, expect.endDate]);
  if ("sessions" in expect) checks.push(["sessions", got.sessions, expect.sessions]);

  const bad = checks.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b));
  if (bad.length === 0) {
    pass += 1;
  } else {
    fails.push(
      `  ${name}：${text}\n` +
        bad.map(([k, a, b]) => `     ${k} 期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`).join("\n")
    );
  }
}

for (const [name, text, expect] of rangeCases) {
  const got = readRanges(text);
  if (JSON.stringify(got) === JSON.stringify(expect)) pass += 1;
  else fails.push(`  readRanges/${name}：期望 ${JSON.stringify(expect)} 实际 ${JSON.stringify(got)}`);
}

console.log(`时间跨度：${pass}/${cases.length + rangeCases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log(f);
  process.exit(1);
}
