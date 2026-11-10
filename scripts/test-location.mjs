/**
 * 地点抽取回归用例。
 *
 * 每条都来自真实通知原文（公文通 / 官网），反例同样是真实踩过的坑：
 * 「参观动线」「地点：深圳大学」「时间地点时间：…」这三种必须抽不到。
 *
 * 用法：node scripts/test-location.mjs
 */
import { extractLocation } from "../lib/location.mjs";

const cases = [];
const hit = (name, input, expected, kind = "physical") =>
  cases.push([name, input, expected, kind]);
const miss = (name, input) => cases.push([name, input, null, null]);

/* ---- 标注式：13 种真实写法 ---- */
hit("标签后换行（正文用 \\n\\r\\n\\r\\n 分隔）", "讲座地点：\n\r\n\r\n深圳大学丽湖校区A6-606", "深圳大学丽湖校区A6-606");
hit("冒号后带空格", "地点： 深圳大学丽湖校区科研楼东塔215会议室", "深圳大学丽湖校区科研楼东塔215会议室");
hit("中英混写 Venue", "地点Venue:深圳大学粤海校区汇星楼565会议室", "深圳大学粤海校区汇星楼565会议室");
hit("尾部句号", "上课地点：致理楼L3-404。", "致理楼L3-404");
hit("无「楼」字但带苑", "地点：深圳大学丽湖校区A7沙河苑", "深圳大学丽湖校区A7沙河苑");
hit("纯数字房号", "地点：深圳大学粤海校区汇文楼2112", "深圳大学粤海校区汇文楼2112");
hit("取值中间有空格", "主会场：丽湖校区 启明楼 D101报告厅", "丽湖校区 启明楼 D101报告厅");
hit("标签与值不同行", "二、活动地点\n 粤海校区汇文楼前广场", "粤海校区汇文楼前广场");
hit("括号里带房号", "地点：学生部学生资助中心（汇昀楼305）", "学生部学生资助中心（汇昀楼305）");
hit("尾部多余括号", "地址：深圳大学粤海校区汇元楼439室）。异议应当…", "深圳大学粤海校区汇元楼439室");
hit("校名与楼名之间有空格", "答辩地点：深圳大学 致腾楼938会议室", "深圳大学 致腾楼938会议室");
hit("课序号注释要剥掉", "地点：粤海校区汇文楼H-05(课序号36)", "粤海校区汇文楼H-05");
hit("讲座地点在前、正文在后", "讲座地点：深圳大学致信楼S630A会议室\n\r\n\r\n主讲人：张三", "深圳大学致信楼S630A会议室");

/* ---- 线上会议 ---- */
hit("地点标注里写腾讯会议号", "地点：腾讯会议 123-456", "腾讯会议 123-456", "online");
hit("线上答辩 + 会议号", "线上答辩 腾讯会议号494 342 964", "腾讯会议 494-342-964", "online");
hit("会议链接", "地点：腾讯会议：https://meeting.tencent.com/dm/6ItU01EElSAB", "腾讯会议（链接）", "online");

/* ---- 叙述式 ---- */
hit("叙述句带日期", "2026年11月5日在汇研楼601会议室召开", "汇研楼601会议室");
hit("叙述句带成功", "在丽湖校区明理楼B104报告厅成功举办", "丽湖校区明理楼B104报告厅");
hit("斋字楼", "在紫薇斋106活动室举办", "紫薇斋106活动室");
hit("教室", "在致艺楼204教室开展", "致艺楼204教室");

/* ---- 反例：必须抽不到 ---- */
miss("参观动线不是活动地点", "专家在负1楼光电子实验室参观，他们认真听取了汇报");
miss("过泛的校名", "地点：深圳大学");
miss("时间地点时间", "三、时间地点时间：2026年11月12日（周四）14:00—17:30");
miss("纯口号", "在玩中学、在学中乐");
miss("非标注的「位置」", "各功能分区位置、整套设施的运行逻辑");

let pass = 0;
const fails = [];

for (const [name, input, expected, kind] of cases) {
  const r = extractLocation(input);
  const okValue = expected === null ? r.location === null : r.location === expected;
  const okKind = expected === null || !kind ? true : r.kind === kind;
  if (okValue && okKind) {
    pass += 1;
  } else {
    fails.push(`${name}\n     期望 ${JSON.stringify(expected)} / ${kind ?? "-"}\n     实际 ${JSON.stringify(r.location)} / ${r.kind ?? "-"}  [${r.rule ?? "-"}]`);
  }
}

console.log(`地点抽取：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}

console.log("\n样例：");
for (const [, input] of cases.slice(0, 4)) {
  const r = extractLocation(input);
  console.log(`  ${String(r.confidence).padEnd(4)} ${r.location}  [${r.rule}]`);
}
