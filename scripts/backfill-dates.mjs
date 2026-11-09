/**
 * 日期回填：用采集器留下的原始文件重算，修正云库里按旧规则写错的 start_at。
 *
 * 背景：旧版 extractWhen 取正文第一个日期，正文里同时出现印发日、报名截止、
 * 活动时间时会把日期写错。新版 lib/parse-time.mjs 改为按上下文择一，
 * 但已经入库的行不会自动更新，需要这个脚本。
 *
 * 只改时间，不删行：
 * 「无活动时间但有截止」的通知里，很多是新闻/系列活动/时间段事件，删掉会误伤。
 *
 * 用法：
 *   node scripts/backfill-dates.mjs            只算不写，打印汇总并导出 CSV
 *   node scripts/backfill-dates.mjs --apply    执行更新（先自动备份旧值）
 *
 * 幂等：重复运行只会处理仍然不一致的行。
 */
import fs from "fs";
import path from "path";
import { pickEventTime } from "../lib/parse-time.mjs";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;
const HEADERS = { "x-wb-webapp-access-key": KEY, "Content-Type": "application/json" };

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const FILES = [
  opt("board", "data/board/notices-latest.json"),
  opt("web", "data/web/notices-web-latest.json"),
];

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${TABLE}?select=id,title,start_at,all_day,source_url,kind` +
      `&source_url=not.is.null&order=id&limit=1000&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`读取失败 ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function timePart(iso) {
  return iso.slice(11, 16);
}

function loadNotices() {
  const all = [];
  for (const file of FILES) {
    if (!fs.existsSync(file)) {
      console.warn(`跳过（文件不存在）：${file}`);
      continue;
    }
    const items = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(items)) continue;
    for (const item of items) all.push(item);
    console.log(`读入 ${items.length} 条：${file}`);
  }
  return all;
}

async function main() {
  const notices = loadNotices();
  if (notices.length === 0) {
    console.error("没有可用的采集文件，先跑 collect:board 或 collect:web");
    process.exit(1);
  }

  const rows = await fetchAll();
  console.log(`云库读到 ${rows.length} 行（含截止行）`);

  const activityByUrl = new Map();
  for (const row of rows) {
    if (row.source_url && !row.source_url.endsWith("#ddl")) activityByUrl.set(row.source_url, row);
  }

  const plan = [];
  let unchanged = 0;
  let notFound = 0;
  let outOfRange = 0;

  for (const item of notices) {
    const row = activityByUrl.get(item.url);
    if (!row) {
      notFound++;
      continue;
    }
    const picked = pickEventTime(item.content || "", item.publishedAt);
    if (!picked.found) {
      // 新规则认为正文没有活动时间：不动，避免把可能的真实日期改成发布日
      unchanged++;
      continue;
    }

    // 正文里可能引用多年前的文件日期（"合同截止 2013-12-31"），
    // 与发布日相差超过一年的，一律不采信
    const deltaDays = (Date.parse(picked.date) - Date.parse(item.publishedAt)) / 86400000;
    if (!Number.isFinite(deltaDays) || deltaDays < -30 || deltaDays > 400) {
      outOfRange++;
      continue;
    }

    // 「下午5:30前提交」这类是截止语境，别把时间安到活动行上
    const curDate = row.start_at.slice(0, 10);
    const curTime = timePart(row.start_at);
    const sameDate = picked.date === curDate;
    const deadlineish = picked.candidates?.some(
      (c) =>
        `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}` === picked.date &&
        c.reasons.includes("截止语境")
    );

    if (sameDate && (!picked.time || picked.time === curTime || deadlineish)) {
      unchanged++;
      continue;
    }

    const nextStart = picked.time
      ? `${picked.date}T${picked.time}:00+08:00`
      : `${picked.date}T00:00:00+08:00`;

    if (nextStart === row.start_at) {
      unchanged++;
      continue;
    }

    plan.push({
      id: row.id,
      title: row.title,
      from: row.start_at,
      to: nextStart,
      before: item.publishedAt,
      reason: picked.phrase.slice(0, 60),
    });
  }

  const dateMoves = plan.filter((p) => p.from.slice(0, 10) !== p.to.slice(0, 10)).length;
  const timeMoves = plan.length - dateMoves;

  console.log("");
  console.log(`命中待改：${plan.length} 条（改日期 ${dateMoves}，只改时间 ${timeMoves}）`);
  console.log(`无需改动：${unchanged} 条；库里没有对应行：${notFound} 条；超出合理区间跳过：${outOfRange} 条`);

  const outDir = path.join("data", "backfill");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const csvPath = path.join(outDir, `plan-${stamp}.csv`);
  const csv = [
    "id,title,from,to,publishedAt,reason",
    ...plan.map((p) =>
      [p.id, p.title, p.from, p.to, p.before, p.reason]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    ),
  ].join("\n");
  fs.writeFileSync(csvPath, csv, "utf-8");
  console.log(`对照表已导出：${csvPath}`);

  if (!APPLY) {
    console.log("\n--dry-run：没有写库。确认后加 --apply 执行。");
    for (const p of plan.slice(0, 6)) {
      console.log(`  ${p.from.slice(0, 16)} → ${p.to.slice(0, 16)}  ${p.title.slice(0, 30)}`);
    }
    return;
  }

  // 先备份旧值，出问题可以照着改回去
  const backupPath = path.join(outDir, `before-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(plan, null, 2), "utf-8");
  console.log(`\n已备份旧值：${backupPath}`);

  let ok = 0;
  let failed = 0;
  for (const p of plan) {
    const res = await fetch(`${TABLE}?id=eq.${p.id}`, {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=representation" },
      body: JSON.stringify({ start_at: p.to, all_day: p.to.slice(11, 16) === "00:00" }),
    });
    if (!res.ok) {
      failed++;
      console.error(`  #${p.id} 失败 ${res.status}: ${(await res.text()).slice(0, 120)}`);
      continue;
    }
    const updated = await res.json();
    if (!Array.isArray(updated) || updated.length === 0) {
      failed++;
      console.error(`  #${p.id} 未生效（可能被权限策略拦截）`);
      continue;
    }
    ok++;
    if (ok % 20 === 0) process.stdout.write(`\r  进度 ${ok}/${plan.length}`);
  }

  console.log(`\n完成：更新 ${ok} 条，失败 ${failed} 条`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("回填失败：", e.message);
  process.exit(1);
});
