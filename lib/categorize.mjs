/**
 * 四个分类的判定。
 *
 * 旧逻辑用 `visual` 单值 + `categoriesOf` 打补丁，结果：
 *   - 「作业」把公文通截止和畅课作业混在一起
 *   - 「课程」把作业、签到、带课程名的通知都吸进去
 *   - 「个人」不看范围，全校的体测/会议也落到个人
 *
 * 现在分类只由来源与标题决定，规则单一、可解释：
 *   课程 = 课表
 *   作业 = 本机待办（畅课/粘贴/扩展/群聊的截止）与签到
 *   校园 = 公共通知且标题没提学院（或明确写了「全校」）
 *   个人 = 公共通知且标题提到本学院
 *   别的学院 → "other"，不进任何分类，只在「全部」模式可见
 *
 * 「别的学院」需要知道「我是哪个学院」才成立。没设画像时 isMine 传 undefined，
 * 这种情况一律归「校园」——不能因为不知道我的学院，就把别人学院的通知说成
 * 「和你无关」，那是替用户做了一个没有依据的判断。
 */

export const CATEGORIES = ["course", "homework", "campus", "personal"];

/** 「XX学院 / XX学部 / XX学院（部）」——只认中文名，最长 10 字，避免把整句吃进来 */
const COLLEGE_RE = /([\u4e00-\u9fa5]{2,10}(?:学院|学部))/g;
const COLLEGE_PREFIX = /^(?:深圳大学|深大|关于|转发|举办|开展|组织|[与和及的])+/;

/** 出现这些词，即使标题里有学院名，也按全校处理（多为「某学院承办」） */
const SCHOOL_WIDE_RE = /全校|全体学生|全体师生|各学院|面向全校|全校师生/;

/** 抓标题里的学院名，去重 */
export function collegeNamesIn(text) {
  const title = String(text || "").normalize("NFKC").replace(/\s+/g, "").replace(COLLEGE_PREFIX, "");
  const found = title.matchAll(COLLEGE_RE);
  const names = new Set();
  for (const m of found) {
    // 「A学院与B学院」会把连接词一起吃掉，这里剥掉开头虚词
    const name = m[1].replace(COLLEGE_PREFIX, "");
    if (name.length >= 3) names.add(name);
  }
  return [...names];
}

/** 标题是否明确写了「全校」口径 */
export function isSchoolWide(title) {
  return SCHOOL_WIDE_RE.test(String(title || ""));
}

/**
 * @param {{
 *   source?: string,        // 课表 / 个人 / 群聊 / 作业截止 …
 *   rawKind: string,        // ddl | checkin | deadline | exam | activity | meeting | pe | other
 *   scope?: string,         // personal | school | college | grade | …
 *   hasCollege: boolean,    // 标题里有没有出现学院名
 *   schoolWide: boolean,    // 标题是否明确面向全校
 *   isMine: boolean | undefined, // 出现的学院名里有没有本学院；undefined = 不知道我的学院
 * }} input
 * @returns {"course"|"homework"|"campus"|"personal"|"other"}
 */
export function categoryOf(input) {
  const { source, rawKind, scope, hasCollege, schoolWide, isMine } = input;

  // 课程只有一个来源：课表
  if (source === "课表") return "course";

  // 本机待办：畅课 / 粘贴 / 扩展（ddl），签到（checkin）
  if (rawKind === "ddl" || rawKind === "checkin") return "homework";

  // 个人侧的截止（群聊排出、自己建的）也算作业
  if (scope === "personal") {
    if (rawKind === "deadline") return "homework";
    return "personal";
  }

  // 公共通知：没提学院 或 明确全校 → 校园；提了本学院 → 个人；确认是别学院 → other
  if (!hasCollege || schoolWide) return "campus";
  if (isMine === true) return "personal";
  if (isMine === false) return "other";
  // undefined：用户还没设学院，判断不了「是不是别人的学院」
  return "campus";
}
