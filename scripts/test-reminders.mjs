/**
 * 站内提醒回归用例。
 *
 * 重点不是"能算出来"，而是这几个边界别错：
 *   - 提前量还没到、也不是当天的，不该提醒（否则一天到晚弹）
 *   - note 写「提醒:关」的，一条都不提示（这是用户主动关的）
 *   - 已完成的、已过期的，不能混进提示条
 *   - 关掉之后不再出现，但截止时间一改要重新出现
 *
 * 用法：node scripts/test-reminders.mjs
 */
import { computeReminders, remindPolicyOf, reminderKey } from "../lib/reminders.mjs";

const NOW = "2026-11-09T22:00:00+08:00";

/** 造一条截止（dueAt 用绝对时间，便于跨天判断） */
function d(key, title, dueAt, extra = {}) {
  return { key, title, dueAt, status: "pending", ...extra };
}

const base = [
  d("ddl:a", "高数作业", "2026-11-09T23:00:00+08:00"),
  d("ddl:b", "英语作文", "2026-11-10T01:00:00+08:00"),
  d("ddl:c", "课程设计", "2026-11-10T01:00:00+08:00", { note: "提前240分钟" }),
  d("ddl:d", "实验报告", "2026-11-09T23:59:00+08:00"),
  d("ddl:e", "关闭提醒的会议", "2026-11-09T22:30:00+08:00", { note: "来自群：班级群 · 提醒:关 · 原话：…" }),
  d("ddl:f", "已交的作业", "2026-11-09T22:30:00+08:00", { status: "done" }),
  d("ddl:g", "已过期的报名", "2026-11-09T20:00:00+08:00"),
];

const cases = [];

// 1. 一小时后截止、无 note → urgent
{
  const r = computeReminders(base, { now: NOW });
  cases.push(["一小时内 → urgent", r.items[0]?.level === "urgent" && r.items[0]?.key === "ddl:a"]);
}

// 2. 跨天的 3 小时后：无 note 不进；note 写了 240 分钟才进
{
  const r = computeReminders(base, { now: NOW });
  const keys = r.items.map((i) => i.key);
  cases.push(["3 小时后且非当天 → 不提示", !keys.includes("ddl:b")]);
  cases.push(["3 小时后但写了提前240分钟 → 提示", keys.includes("ddl:c")]);
  cases.push(["提前240分钟归为 soon", r.items.find((i) => i.key === "ddl:c")?.level === "soon"]);
}

// 3. 当天 23:59，提前量还没到（119 分钟 > 60）也要提示
{
  const r = computeReminders(base, { now: NOW });
  cases.push(["当天到期 → 即使没到提前量也提示", r.items.some((i) => i.key === "ddl:d")]);
}

// 4. 关闭提醒 / 已完成 / 已过期
{
  const r = computeReminders(base, { now: NOW });
  const keys = r.items.map((i) => i.key);
  cases.push(["提醒:关 → 不提示", !keys.includes("ddl:e")]);
  cases.push(["已完成 → 不提示", !keys.includes("ddl:f")]);
  cases.push(["已过期 → 不进 items", !keys.includes("ddl:g")]);
  cases.push(["已过期计入 overdue", r.overdue === 1]);
}

// 5. 排序按截止时间
{
  const r = computeReminders(base, { now: NOW });
  const sorted = [...r.items].every((item, i, arr) => i === 0 || arr[i - 1].dueAt <= item.dueAt);
  cases.push(["按截止时间升序", sorted]);
  cases.push(["next 是最早的一条", r.next?.key === "ddl:a"]);
}

// 6. 关掉之后不再出现
{
  const dismissed = [reminderKey(base[0])];
  const r = computeReminders(base, { now: NOW, dismissed });
  cases.push(["已关闭的条目不出现", !r.items.some((i) => i.key === "ddl:a")]);
}

// 7. 截止时间改了 → 重新提醒（key 同、dueAt 变）
{
  const dismissed = [`ddl:a@2026-11-09T21:00:00+08:00`];
  const r = computeReminders(base, { now: NOW, dismissed });
  cases.push(["改了截止时间 → 重新提醒", r.items.some((i) => i.key === "ddl:a")]);
}

// 8. 空数据不报错
{
  const r = computeReminders([], { now: NOW });
  cases.push(["空数据不报错", r.total === 0 && r.next === null]);
}

// 9. 策略解析
{
  const cases2 = [
    ["来自群：X · 提醒:提前30分钟 · 原话：…", "lead", 30],
    ["来自群：X · 提醒:关", "off", 0],
    ["随便一段没有提醒的备注", "lead", 60],
    [null, "lead", 60],
  ];
  for (const [note, mode, minutes] of cases2) {
    const p = remindPolicyOf(note);
    cases.push([`策略 ${mode}/${minutes}`, p.mode === mode && p.minutes === minutes]);
  }
}

let pass = 0;
const fails = [];
for (const [name, ok] of cases) {
  if (ok) pass += 1;
  else fails.push(name);
}

console.log(`站内提醒：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}

// 顺带打印一次实际结果，便于人工核对
const sample = computeReminders(base, { now: NOW });
console.log("\n当前应提示：");
for (const item of sample.items) {
  console.log(`  [${item.level}] ${item.title}  剩余 ${item.minutesLeft} 分钟`);
}
console.log(`  已过期 ${sample.overdue} 条`);
