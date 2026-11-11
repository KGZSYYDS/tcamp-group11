/**
 * 通知内容类型的回归用例。
 *
 * 这些标题全部来自真实公文通，而且都是踩过坑的：
 * 改规则时先跑这个，别让「奖学金名单公示」又跑回默认可见的位置。
 *
 * 用法：node scripts/test-notice-kind.mjs
 */
import { noticeKindOf, NOTICE_KINDS } from "../lib/notice-kind.mjs";

const cases = [];
const check = (title, expected) => {
  const actual = noticeKindOf(title);
  cases.push([title, actual === expected, `${actual} ≠ ${expected}`]);
};

/* ---- 教务：错过要出事，默认必须显示 ---- */
check("关于做好2026-2027学年第一学期选课工作的通知", "academic");
check("《高等代数（1）》课程期中考试通知", "academic");
check("关于《发展心理学》MOOC课程调课的通知", "academic");
check("关于2026年下半年全国大学英语四六级考试报名的通知", "academic");
check("关于开展2026年学生体质健康测试的通知", "academic");
check("关于申请修读艺术学部美术与设计学院2025级辅修专业及辅修学士学位的通知", "academic");
check("关于台风期间停课的通知", "academic");

/* ---- 领航讲座：单独成类，只有大一默认开 ---- */
check("“领航讲座”第二十五讲 | 从地面走向空间：基于我国自主卫星的环境遥感监测", "linghang");
check("“优鹏计划·创新领航系列讲座”第86讲：AI时代的短视频营销", "linghang");

/* ---- 奖助：要申请、要还贷的才算；名单公示不算 ---- */
check("【资助工作】关于开展2026-2027学年度全日制学生校园地国家助学贷款续贷工作的通知", "aid");
check("关于评选2026年国家奖学金的通知", "aid");
check("教育学部2026年本科生国家励志奖学金及助学金 拟推荐名单公示（有更新）", "publicity");
check("【资助工作】关于公示我校2026年国家励志奖学金拟获奖学生名单的通知", "publicity");

/* ---- 机会：能报名、能投简历、能去 ---- */
check("2027届就业工作（31）：【企业参访】海康威视企业参访活动学生报名通知", "opportunity");
check("关于举办第四届全国大学生职业规划大赛建筑与城市规划学院院赛的通知", "opportunity");
check("创新创业短课《中国海洋权益问题研究》学生招募公告", "opportunity");

/* ---- 讲座：纯资讯，默认不打扰 ---- */
check("医学部学术讲座：神经影像的定量分析研究进展", "lecture");
check("活动招募|【减压友能量】第10期智能助眠体验团体", "lecture");

/* ---- 事务：不是给学生看的 ---- */
check("预评估组专家参观深大校园", "admin");
check("我校召开本科教学工作水平预评估校长汇报会", "admin");
check("关于深圳市科技计划项目结题验收的通知", "admin");
check("【研招总结】计算机与软件学院2026年研究生招生宣传活动总结", "admin");
check("关于做好2026年绿色出行活动的通知", "admin");
check("安全保卫部关于立德门、致远门临时管制的通知", "admin");

/* ---- 兜底：认不出来就不打扰（默认关） ---- */
check("讣告", "other");
check("一周校园学术动态(4月16日至4月22日)", "other");
check("", "other");

/* ---- 类型清单本身 ---- */
cases.push(["分类清单", NOTICE_KINDS.includes("academic") && NOTICE_KINDS.includes("linghang"), "缺类型"]);

let pass = 0;
const fails = [];
for (const [name, ok, detail] of cases) {
  if (ok) pass += 1;
  else fails.push(`${name}（${detail}）`);
}

console.log(`通知类型判定：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
