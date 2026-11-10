/**
 * 分类回归用例。
 *
 * 四个分类各自只能来自一个源头：
 *   课程 = 课表；作业 = 本机待办与签到；校园 = 没提学院的全校通知；个人 = 提了本学院。
 * 别的学院必须落 "other"，否则又会出现「个人里全是别学院事务」。
 *
 * 用法：node scripts/test-categorize.mjs
 */
import { categoryOf, collegeNamesIn, isSchoolWide, CATEGORIES } from "../lib/categorize.mjs";

const cases = [];
const check = (name, actual, expected) =>
  cases.push([name, JSON.stringify(actual) === JSON.stringify(expected), `${actual} ≠ ${expected}`]);

/* ---- 课程：只认课表 ---- */
check(
  "课表 → 课程",
  categoryOf({ source: "课表", rawKind: "other", scope: "personal", hasCollege: false, schoolWide: false, isMine: false }),
  "course"
);

/* ---- 作业：本机待办 + 签到 ---- */
check(
  "畅课作业(ddl) → 作业",
  categoryOf({ rawKind: "ddl", scope: "personal", hasCollege: false, schoolWide: false, isMine: false }),
  "homework"
);
check(
  "签到(checkin) → 作业",
  categoryOf({ rawKind: "checkin", scope: "personal", hasCollege: false, schoolWide: false, isMine: false }),
  "homework"
);
check(
  "群聊排出的截止 → 作业",
  categoryOf({ source: "群聊", rawKind: "deadline", scope: "personal", hasCollege: false, schoolWide: false, isMine: false }),
  "homework"
);
check(
  "自己建的日程 → 个人",
  categoryOf({ source: "个人", rawKind: "other", scope: "personal", hasCollege: false, schoolWide: false, isMine: false }),
  "personal"
);

/* ---- 公共通知：校园 / 个人 / 别的学院 ---- */
const pub = (over = {}) => ({
  rawKind: "other",
  scope: "school",
  hasCollege: false,
  schoolWide: false,
  isMine: false,
  ...over,
});

check("公共·没提学院 → 校园", categoryOf(pub()), "campus");
check("公共·提本学院 → 个人", categoryOf(pub({ hasCollege: true, isMine: true })), "personal");
check("公共·提别学院 → other", categoryOf(pub({ hasCollege: true, isMine: false })), "other");
check(
  "公共·有学院名但写明全校 → 校园",
  categoryOf(pub({ hasCollege: true, isMine: false, schoolWide: true })),
  "campus"
);
check(
  "公文通截止·别学院 → other（不算作业）",
  categoryOf(pub({ rawKind: "deadline", hasCollege: true, isMine: false })),
  "other"
);
check(
  "公文通截止·没提学院 → 校园（不算作业）",
  categoryOf(pub({ rawKind: "deadline" })),
  "campus"
);

/* ---- 标题解析 ---- */
check("抓出学院名", collegeNamesIn("计算机与软件学院2026年专场招聘会"), ["计算机与软件学院"]);
check("多个学院名去重", collegeNamesIn("计算机与软件学院与数学科学学院联合举办"), ["计算机与软件学院", "数学科学学院"]);
check("没学院名 → 空", collegeNamesIn("关于2026年国庆节放假安排的通知"), []);
check("「全校」识别", isSchoolWide("面向全校学生的体测安排"), true);
check("普通标题不算全校", isSchoolWide("关于开展实验室安全检查的通知"), false);

/* ---- 分类清单本身 ---- */
check("四个分类", CATEGORIES, ["course", "homework", "campus", "personal"]);

let pass = 0;
const fails = [];
for (const [name, ok, detail] of cases) {
  if (ok) pass += 1;
  else fails.push(`${name}（${detail}）`);
}

console.log(`分类判定：${pass}/${cases.length} 通过`);
if (fails.length) {
  console.log("\n失败：");
  for (const f of fails) console.log("  ✗", f);
  process.exit(1);
}
