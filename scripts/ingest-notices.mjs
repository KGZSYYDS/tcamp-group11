/**
 * 公文通 / 官网采集结果 → 云数据库（events 表，scope=school 公共事件）
 *
 * 直接走数据面 REST（PostgREST 语义），不依赖浏览器登录态：
 *   POST https://<endpoint>/.cloud/database/rest/events
 *   header: x-wb-webapp-access-key: <lib/cloud.ts 里的 publishableKey>
 *
 * 一条通知可能产生两行：
 *   ① 活动本身（讲座 11/20 开讲）—— 正文里有明确时间才生成
 *   ② 报名/提交截止（11/9 12:00 前报名）—— 正文里有截止表达才生成，source_url 带 #ddl
 * 两行分开存，是因为它们在日历上落在不同日期，合成一条必然丢一半信息。
 *
 * 两个源共用这一套逻辑（字段完全同构，只是来源不同）：
 *   --source board  公文通 www1.szu.edu.cn/board/（要登录，校内通知）
 *   --source web    官网 www.szu.edu.cn（公开，公告/学术动态/新闻）
 *
 * 幂等：按 source_url 去重，重复运行只补新增。
 *
 * 用法：
 *   node scripts/ingest-notices.mjs --dry-run
 *   node scripts/ingest-notices.mjs
 *   node scripts/ingest-notices.mjs --source web --file data/web/notices-web-latest.json
 *   node scripts/ingest-notices.mjs --ddl-only       只补截止（已入库的通知也能补）
 *   node scripts/ingest-notices.mjs --no-ddl         只要活动，不要截止
 *   node scripts/ingest-notices.mjs --file data/board/notices-20261108.json --batch 40
 */
import fs from "fs";
import path from "path";
import { extractDeadline, isActionableDeadline, isFacultyDeadline } from "../lib/deadline.mjs";
import { pickEventTime } from "../lib/parse-time.mjs";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DRY = argv.includes("--dry-run");
const DDL_ONLY = argv.includes("--ddl-only");
const NO_DDL = argv.includes("--no-ddl");
const BATCH = Number(opt("batch", "40"));
const SOURCE = opt("source", "board");
const FILE = path.resolve(
  opt("file", SOURCE === "web" ? "data/web/notices-web-latest.json" : "data/board/notices-latest.json")
);

const HEADERS = {
  "x-wb-webapp-access-key": KEY,
  "Content-Type": "application/json",
};

// ---------- 分类 ----------

const KIND_RULES = [
  ["pe", /体测|体质测试|体能|军训|体检|运动会|军训/],
  ["exam", /考试|期末|期中|补考|重修|四六级|CET|测验|监考|成绩复核|答辩|开题|中期检查|复试/],
  [
    "activity",
    /讲座|讲学|论坛|沙龙|研讨|报告会|开放日|展览|演出|比赛|竞赛|大赛|招募|报名|宣讲|招聘|双选会|创新领航|社团|义诊|志愿服务|训练营|工作坊/,
  ],
];

function classify(title, category) {
  for (const [kind, re] of KIND_RULES) if (re.test(title)) return kind;
  if (category === "讲座") return "activity";
  return "other";
}

// ---------- 时间提取 ----------

/**
 * 活动时间优先取正文里真正的「活动时刻」，取不到退回发布日期。
 *
 * 一条公文里通常有多个日期（印发、文号、报名截止、活动），直接取第一个必然出错，
 * 所以交给 lib/parse-time.mjs 按上下文打分择一。
 *
 * 返回值仍带 found：区分「正文真的写了时间」和「只是拿发布日期兜底」。
 * 后者不算事件时间——一条只有报名截止的通知，发布日期不是任何事发生的时刻。
 */
function extractWhen(item) {
  return pickEventTime(item.content || "", item.publishedAt);
}

/**
 * 一条通知 → 1~2 行。
 *
 * 判断「要不要出活动行」用的不是「有没有时间」，而是「正文里有没有真正的活动时间」：
 * 一条只写「请于11月20日前提交」的通知，摘要时间只是发布日期，
 * 拿它当事件时间会在日历上多出一个毫无意义的点。
 */
function toRows(item) {
  const when = extractWhen(item);
  const kind = classify(item.title || "", item.category);
  const rows = [];

  const baseNote = [
    item.category ? `栏目：${item.category}` : null,
    item.department ? `发布：${item.department}` : null,
    item.content ? item.content.slice(0, 300).replace(/\s+/g, " ") : null,
  ].filter(Boolean);

  const base = {
    kind,
    title: (item.title || "").slice(0, 200),
    start_at: when.time ? `${when.date}T${when.time}:00+08:00` : `${when.date}T00:00:00+08:00`,
    all_day: !when.time,
    link: item.url,
    note: baseNote.join("｜") || null,
    scope: "school",
    source: SOURCE,
    source_url: item.url,
  };

  // 截止行：只收学生能用上的（老师申报项目、数据库试用到期这些不进日历）
  let ddl = null;
  if (!NO_DDL) {
    const d = extractDeadline(item.content, item.publishedAt);
    if (d && isActionableDeadline(item.title) && !isFacultyDeadline(item.title, item.content)) {
      ddl = d;
      // 没写具体钟点就按当日 23:59 算：截止这类东西，写成「全天」在倒计时里没法用
      const time = d.time || "23:59";
      rows.push({
        kind: "deadline",
        title: (item.title || "").slice(0, 200),
        start_at: `${d.date}T${time}:00+08:00`,
        all_day: false,
        link: item.url,
        note: [`截止：${d.date} ${d.time || "23:59（正文未写钟点）"}`, `原话：${d.phrase}`]
          .concat(item.department ? [`发布：${item.department}`] : [])
          .join("｜"),
        scope: "school",
        source: SOURCE,
        // 同一篇通知的活动行与截止行共用一个 url，靠后缀区分身份
        source_url: `${item.url}#ddl`,
      });
    }
  }

  if (DDL_ONLY) return rows;

  // 有真实活动时间，或者根本抽不出截止 → 保留活动行
  if (when.found || !ddl) rows.push(base);
  return rows;
}

// ---------- 主流程 ----------

/**
 * 读取库里已有的 source_url。
 * 不限定 source：插件的 gwt-sync 与本次的 board 指向同一篇通知时，
 * 保留先入库的那条（插件那条通常经过 AI 解析，字段更全）。
 */
async function existingUrls() {
  const urls = new Set();
  let offset = 0;
  const pageSize = 1000;
  for (;;) {
    const res = await fetch(
      `${TABLE}?select=source_url&source_url=not.is.null&limit=${pageSize}&offset=${offset}`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`读取已有数据失败 ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    for (const r of rows) if (r.source_url) urls.add(r.source_url);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return urls;
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(
      `找不到 ${FILE}\n先跑：` +
        (SOURCE === "web" ? "npm run collect:web" : "npm run collect:board -- --login")
    );
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  if (!Array.isArray(items) || items.length === 0) {
    console.error("文件没有条目");
    process.exit(1);
  }

  const rows = items.filter((it) => it.title && it.url).flatMap(toRows);

  const dist = rows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
  const ddlRows = rows.filter((r) => r.kind === "deadline");
  const today = new Date().toISOString().slice(0, 10);
  const liveDdl = ddlRows.filter((r) => r.start_at.slice(0, 10) >= today);
  console.log(`读入 ${items.length} 条通知 → ${rows.length} 行：${path.basename(FILE)}（source=${SOURCE}）`);
  console.log("分类分布：", dist);
  console.log(`截止行 ${ddlRows.length} 条，其中未过期 ${liveDdl.length} 条`);

  if (DRY) {
    console.log("\n--dry-run 截止行（前 8 条）：");
    for (const r of liveDdl.slice(0, 8)) {
      console.log(`  ${r.start_at.slice(0, 16)}  ${r.title.slice(0, 40)}`);
      console.log(`      ${r.note.split("｜")[1] || ""}`);
    }
    return;
  }

  console.log("读取库内已有 source_url……");
  const exists = await existingUrls();
  const todo = rows.filter((r) => !exists.has(r.source_url));
  console.log(`库里已有 ${exists.size} 条带 source_url 的记录，本次需新增 ${todo.length} 条`);

  if (todo.length === 0) return;

  let added = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const res = await fetch(TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(chunk),
    });
    if (res.ok) {
      added += chunk.length;
    } else {
      const err = await res.text();
      failed += chunk.length;
      console.error(`\n  批量写入失败（${i}-${i + chunk.length}）: ${res.status} ${err.slice(0, 300)}`);
    }
    process.stdout.write(`\r  进度 ${Math.min(i + BATCH, todo.length)}/${todo.length}  新增 ${added} 失败 ${failed}`);
  }

  console.log(`\n\n完成：新增 ${added} 条，失败 ${failed} 条`);
}

main().catch((e) => {
  console.error("入库失败：", e.message);
  process.exit(1);
});
