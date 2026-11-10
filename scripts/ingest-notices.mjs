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
import { extractLocation } from "../lib/location.mjs";

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
  // 地点必须从 content 全文抽：note 只截了前 300 字，95% 的正文超过这个长度。
  // 采集方若已经带了 location（如插件/群聊），优先用它，别覆盖人工或上游的结果。
  const loc = extractLocation(item.content || "");
  const location = (item.location && String(item.location).trim()) || loc.location;
  const rows = [];

  const baseNote = [
    item.category ? `栏目：${item.category}` : null,
    item.department ? `发布：${item.department}` : null,
    item.content ? item.content.slice(0, 300).replace(/\s+/g, " ") : null,
  ].filter(Boolean);

  // 活动行：一篇通知可能有多段（上午/下午分开签到），每段一条。
  // 第一段沿用原 url，多出来的用 #s2/#s3，既能让每段独立存在，也不会与历史数据重复。
  const sessions = when.sessions?.length
    ? when.sessions
    : [{ date: when.date, start: when.time, end: null }];

  const activityRows = sessions.map((s, i) => ({
    kind,
    title: (item.title || "").slice(0, 200),
    start_at: s.start ? `${s.date}T${s.start}:00+08:00` : `${s.date}T00:00:00+08:00`,
    // 结束时间：同一天有钟点就写钟点；整段日期区间写到末日 23:59；都没有就不写，
    // 让前端按默认 1 小时兜底，而不是塞一个假的结束时间。
    end_at: s.end
      ? `${s.date}T${s.end}:00+08:00`
      : when.endDate
        ? `${when.endDate}T23:59:00+08:00`
        : null,
    all_day: !s.start,
    link: item.url,
    note: baseNote.join("｜") || null,
    scope: "school",
    source: SOURCE,
    source_url: i === 0 ? item.url : `${item.url}#s${i + 1}`,
    location,
    // 解析是否真的找到了活动时间。找不到时不能拿发布日期去覆盖库里已有的时间。
    _trusted: when.found,
  }));

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
        note: [`截止：${d.date}${d.time ? ` ${d.time}` : ""}`, `原话：${d.phrase}`]
          .concat(item.department ? [`发布：${item.department}`] : [])
          .join("｜"),
        scope: "school",
        source: SOURCE,
        // 同一篇通知的活动行与截止行共用一个 url，靠后缀区分身份
        source_url: `${item.url}#ddl`,
        _trusted: true,
      });
    }
  }

  if (DDL_ONLY) return rows;

  // 只有真的抽到活动时间才进日历。
  // 抽不到就别硬塞发布日：那样的「事件」在日历上只是噪音，
  // 而且会让人误以为那天真有活动（实测 233 条属于这种）。
  if (when.found) rows.push(...activityRows);
  return rows;
}

// ---------- 主流程 ----------

/**
 * 读取库里已有的 source_url。
 * 不限定 source：插件的 gwt-sync 与本次的 board 指向同一篇通知时，
 * 保留先入库的那条（插件那条通常经过 AI 解析，字段更全）。
 */
async function existingRows() {
  const map = new Map();
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${TABLE}?select=id,source_url,start_at,end_at,all_day,location` +
      `&source_url=not.is.null&order=id&limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`读取已有行失败 ${res.status}`);
    const page = await res.json();
    for (const r of page) if (r.source_url) map.set(r.source_url, r);
    if (page.length < 1000) break;
  }
  return map;
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
    console.log("\n--dry-run 地点（前 10 条）：");
    for (const r of rows.filter((x) => x.location).slice(0, 10)) {
      console.log(`  ${r.location}   ← ${r.title.slice(0, 34)}`);
    }

    console.log("\n--dry-run 截止行（前 8 条）：");
    for (const r of liveDdl.slice(0, 8)) {
      console.log(`  ${r.start_at.slice(0, 16)}  ${r.title.slice(0, 40)}`);
      console.log(`      ${r.note.split("｜")[1] || ""}`);
    }

    console.log("\n--dry-run 时间（前 8 条带结束时间的）：");
    for (const r of rows.filter((x) => x.end_at).slice(0, 8)) {
      console.log(`  ${r.start_at.slice(11, 16)}–${r.end_at.slice(11, 16)}  ${r.title.slice(0, 34)}`);
    }
  }

  console.log("读取库内已有记录……");
  const existing = await existingRows();

  // 通知改期是常事：已存在的行不再一律跳过，而是比对时间，变了就更新。
  // 这样「学校把 11 月 12 日改成 11 月 15 日」能自动跟上，不用等人工回填。
  const todo = [];
  const updates = [];
  for (const r of rows) {
    const cur = existing.get(r.source_url);
    if (!cur) {
      todo.push(r);
      continue;
    }
    // 没抽到活动时间的行只允许「新增」，不允许改已有记录，
    // 否则一次规则回归就会把整批时间退化成发布日期
    if (r._trusted === false) continue;
    const patch = {};
    if (cur.start_at !== r.start_at) patch.start_at = r.start_at;
    if ((cur.end_at ?? null) !== (r.end_at ?? null)) patch.end_at = r.end_at ?? null;
    if (Boolean(cur.all_day) !== Boolean(r.all_day)) patch.all_day = r.all_day;
    // 地点只补空值，不覆盖人工改过的
    if (!cur.location && r.location) patch.location = r.location;
    if (Object.keys(patch).length) updates.push({ id: cur.id, patch, title: r.title });
  }

  console.log(
    `库里已有 ${existing.size} 条带 source_url 的记录：需新增 ${todo.length} 条，需更新 ${updates.length} 条`
  );

  if (DRY) {
    console.log(`\n--dry-run：会新增 ${todo.length} 条，会更新 ${updates.length} 条（未写库）`);
    for (const u of updates.slice(0, 6)) {
      console.log(`  更新 #${u.id} ${u.title.slice(0, 30)}  ${JSON.stringify(u.patch)}`);
    }
    return;
  }

  if (updates.length) {
    let patched = 0;
    let patchFailed = 0;
    for (const u of updates) {
      const res = await fetch(`${TABLE}?id=eq.${u.id}`, {
        method: "PATCH",
        headers: { ...HEADERS, Prefer: "return=representation" },
        body: JSON.stringify(u.patch),
      });
      const changed = res.ok ? await res.json() : null;
      if (!Array.isArray(changed) || changed.length === 0) {
        patchFailed += 1;
      } else {
        patched += 1;
      }
    }
    console.log(`  更新 ${patched} 条，失败 ${patchFailed} 条（失败多为插件建的行，受行级权限限制）`);
  }

  if (todo.length === 0) return;

  // _trusted 是内部标记，不能发给数据库
  for (const r of todo) delete r._trusted;

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
