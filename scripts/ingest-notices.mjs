/**
 * 公文通采集结果 → 云数据库（events 表，scope=school 公共事件）
 *
 * 直接走数据面 REST（PostgREST 语义），不依赖浏览器登录态：
 *   POST https://<endpoint>/.cloud/database/rest/events
 *   header: x-wb-webapp-access-key: <lib/cloud.ts 里的 publishableKey>
 *
 * 幂等：按 source_url 去重，重复运行只补新增。
 *
 * 用法：
 *   node scripts/ingest-notices.mjs --dry-run
 *   node scripts/ingest-notices.mjs
 *   node scripts/ingest-notices.mjs --file data/board/notices-20261108.json --batch 40
 */
import fs from "fs";
import path from "path";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DRY = argv.includes("--dry-run");
const BATCH = Number(opt("batch", "40"));
const FILE = path.resolve(opt("file", "data/board/notices-latest.json"));

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

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * 活动时间优先取正文里的「时间：…」，取不到退回发布日期。
 * 公文正文常见写法：2026年11月9日（一）10：00 / 11月9日 14:30
 */
function extractWhen(item) {
  const text = item.content || "";
  const pubDate = /^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt || "")
    ? item.publishedAt
    : new Date().toISOString().slice(0, 10);

  // 1) 带年份的完整日期 + 时间
  let m = text.match(
    /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d]{0,12}(\d{1,2})\s*[:：]\s*(\d{2})/
  );
  if (m) {
    return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time: `${pad(m[4])}:${m[5]}` };
  }

  // 2) 只有月日 + 时间，年份取发布年
  const year = pubDate.slice(0, 4);
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d]{0,12}(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m) {
    return { date: `${year}-${pad(m[1])}-${pad(m[2])}`, time: `${pad(m[3])}:${m[4]}` };
  }

  // 3) 只有日期
  m = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time: null };

  return { date: pubDate, time: null };
}

function toRow(item) {
  const when = extractWhen(item);
  const kind = classify(item.title || "", item.category);

  // 备注里放分类/单位 + 正文摘要，方便前端展示与后续 AI 精修
  const noteParts = [
    item.category ? `栏目：${item.category}` : null,
    item.department ? `发布：${item.department}` : null,
    item.content ? item.content.slice(0, 300).replace(/\s+/g, " ") : null,
  ].filter(Boolean);

  return {
    kind,
    title: (item.title || "").slice(0, 200),
    start_at: when.time ? `${when.date}T${when.time}:00+08:00` : `${when.date}T00:00:00+08:00`,
    all_day: !when.time,
    link: item.url,
    note: noteParts.join("｜") || null,
    scope: "school",
    source: "board",
    source_url: item.url,
  };
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
    console.error(`找不到 ${FILE}\n先跑：npm run collect:board -- --login`);
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(FILE, "utf-8"));
  if (!Array.isArray(items) || items.length === 0) {
    console.error("文件没有条目");
    process.exit(1);
  }

  const rows = items.filter((it) => it.title && it.url).map(toRow);

  const dist = rows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
  console.log(`读入 ${rows.length} 条：${path.basename(FILE)}`);
  console.log("分类分布：", dist);

  if (DRY) {
    console.log("\n--dry-run 预览前 3 条：");
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    return;
  }

  console.log("读取库内已有 source_url……");
  const exists = await existingUrls();
  const todo = rows.filter((r) => !exists.has(r.source_url));
  console.log(`库里已有 ${exists.size} 条 board 来源，本次需新增 ${todo.length} 条`);

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
