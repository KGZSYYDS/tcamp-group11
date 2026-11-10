/**
 * 回填 events.location。
 *
 * 背景：入库脚本过去没写过 location，636 行里 582 行公文通 / 45 行官网全空。
 * 正文里的「地点：致理楼201」被截进 note 前 300 字，而 note 只存 300 字，
 * 所以**必须从采集文件里的 content 全文重抽**，不要拿库里的 note 重抽。
 *
 * 用法：
 *   node scripts/backfill-location.mjs                # 演练，只出对照表
 *   node scripts/backfill-location.mjs --only web     # 只处理官网
 *   node scripts/backfill-location.mjs --apply        # 写库（先备份旧值）
 *   node scripts/backfill-location.mjs --apply --force # 连已有值一起覆盖
 *
 * 幂等：只填空值、跳过同值；跑第二遍应当输出「更新 0」。
 */
import fs from "fs";
import path from "path";
import { extractLocation } from "../lib/location.mjs";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = process.env.WB_ACCESS_KEY || "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;
const HEADERS = { "x-wb-webapp-access-key": KEY, "Content-Type": "application/json" };

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const NO_CSV = argv.includes("--no-csv");
const ONLY = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? argv[i + 1] : null;
})();

const DIR = "data";
const SOURCES = [
  { source: "board", file: path.join(DIR, "board", "notices-latest.json") },
  { source: "web", file: path.join(DIR, "web", "notices-web-latest.json") },
].filter((s) => !ONLY || s.source === ONLY);

function loadItems() {
  const items = [];
  const seen = new Set();
  for (const { source, file } of SOURCES) {
    if (!fs.existsSync(file)) {
      console.log(`跳过（文件不存在）：${file}`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const arr = Array.isArray(parsed) ? parsed : parsed.items || parsed.notices || [];
    for (const it of arr) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      items.push({ ...it, _source: source });
    }
  }
  return items;
}

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${TABLE}?select=id,title,source_url,location,source` +
      `&source_url=not.is.null&order=id&limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`读取失败 ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const items = loadItems();
  console.log(`采集文件：${items.length} 条（${SOURCES.map((s) => s.source).join(" + ")}）`);

  // url → 抽取结果
  const byUrl = new Map();
  let extracted = 0;
  for (const it of items) {
    const r = extractLocation(it.content || "");
    if (!r.location) continue;
    byUrl.set(it.url, r);
    extracted += 1;
  }
  console.log(`抽到地点：${extracted} 条（${((extracted / items.length) * 100).toFixed(1)}%）`);

  const rows = await fetchAll();
  console.log(`库里带 source_url 的行：${rows.length}`);

  const plan = [];
  const skip = { noSource: 0, noHit: 0, keepExisting: 0, same: 0 };

  for (const row of rows) {
    // 截止行的 source_url 带 #ddl 后缀，不去掉会漏掉全部截止行
    const url = String(row.source_url || "").replace(/#ddl$/, "");
    if (!url) {
      skip.noSource += 1;
      continue;
    }
    const hit = byUrl.get(url);
    if (!hit) {
      skip.noHit += 1;
      continue;
    }
    const from = row.location || null;
    if (from && !FORCE) {
      skip.keepExisting += 1;
      continue;
    }
    if (from === hit.location) {
      skip.same += 1;
      continue;
    }
    plan.push({
      id: row.id,
      title: String(row.title || "").slice(0, 60),
      source: row.source,
      from,
      to: hit.location,
      kind: hit.kind,
      confidence: hit.confidence,
      rule: hit.rule,
      phrase: hit.phrase,
    });
  }

  const bySource = plan.reduce((acc, p) => ({ ...acc, [p.source]: (acc[p.source] || 0) + 1 }), {});
  console.log(`\n待写入 ${plan.length} 条：`, JSON.stringify(bySource));
  console.log(`跳过：无来源 ${skip.noSource} · 未抽到 ${skip.noHit} · 保留原值 ${skip.keepExisting} · 已相同 ${skip.same}`);

  if (plan.length) {
    console.log("\n样例（前 12 条）：");
    for (const p of plan.slice(0, 12)) {
      console.log(`  #${p.id} ${p.to}   ← ${p.title}`);
    }
  }

  if (!NO_CSV) {
    const outDir = path.join("data", "backfill");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const csvPath = path.join(outDir, `location-plan-${stamp}.csv`);
    const csv = [
      "id,source,title,from,to,kind,confidence,rule,phrase",
      ...plan.map((p) =>
        [p.id, p.source, p.title, p.from, p.to, p.kind, p.confidence, p.rule, p.phrase].map(csvCell).join(",")
      ),
    ].join("\n");
    fs.writeFileSync(csvPath, csv, "utf-8");
    console.log(`\n对照表：${csvPath}`);
  }

  if (!APPLY) {
    console.log("\n--dry-run：没有写库。确认后加 --apply 执行。");
    return;
  }

  // 写前备份
  const outDir = path.join("data", "backfill");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(outDir, `location-before-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(plan.map(({ id, from }) => ({ id, location: from })), null, 2), "utf-8");
  console.log(`\n旧值已备份：${backupPath}`);

  let ok = 0;
  let failed = 0;
  for (const p of plan) {
    const res = await fetch(`${TABLE}?id=eq.${p.id}`, {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=representation" },
      body: JSON.stringify({ location: p.to }),
    });
    if (!res.ok) {
      failed += 1;
      console.error(`  #${p.id} 失败 ${res.status}: ${(await res.text()).slice(0, 100)}`);
      continue;
    }
    const updated = await res.json();
    // 200 但没回行 = 被权限策略拦了，不能算成功
    if (!Array.isArray(updated) || updated.length === 0) {
      failed += 1;
      console.error(`  #${p.id} 未生效（可能被权限策略拦截）`);
      continue;
    }
    ok += 1;
    if (ok % 20 === 0) process.stdout.write(`\r  进度 ${ok}/${plan.length}`);
  }

  console.log(`\n完成：更新 ${ok} 条，失败 ${failed} 条`);
}

main().catch((e) => {
  console.error("回填失败：", e?.message || e);
  process.exit(1);
});
