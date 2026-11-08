/**
 * 个人课表采集器
 *
 * 数据分两段取，各取所长：
 *   课表本体 ← 办事大厅「我的课表」(ehall / jwapp / wdkb)，字段最全（周次掩码、教室、教师）
 *   周次锚点 ← 教学管理系统 (jwkw / homeapp)，能给出「某天属于第几周」，是校历的权威口径
 *
 * 为什么不都用 ehall：wdkb 的 dqzc.do 返回的 ZC 与教务口径差一周（实测 11/8 它给 11，
 * 教务 jwkw 给 10 且页面明确写「第10周 11/2~11/8」）。差这一周，整学期课表就全错位。
 *
 * 课表行字段：KCM 课程名 / SKJS 教师 / JASMC 教室 / SKXQ 星期 / KSJC~JSJC 节次
 *             ZCMC 周次说明 / SKZC 周次掩码（第 n 位 = 1 表示第 n 周上这门课）
 *
 * 归属：课表是「个人数据」，但脚本用的是公共 anon 密钥，写进去的 owner_id 只能是 anon。
 *      所以 source_url 里带上「学号哈希」的前 16 位（ehall://xskcb/<hash>/<JXBID>/…），
 *      前端登录后凭学号算出同一个哈希来「认领」，认领后 owner_id 才变成该用户，
 *      课表也只对本人可见（见 lib/data.ts claimTimetable）。
 *      注意：这里只写哈希，绝不写学号明文——events 表是公开可读的。
 *
 * 用法：
 *   node scripts/collect-timetable.mjs --dry-run     只看解析结果，不写库
 *   node scripts/collect-timetable.mjs               采下来 + 写入云数据库
 *   node scripts/collect-timetable.mjs --no-db       只写 data/timetable/*.json
 *   node scripts/collect-timetable.mjs --week1 2026-08-31   手动指定第 1 周周一
 *   node scripts/collect-timetable.mjs --term 2026-2027-1   指定学期
 *   node scripts/collect-timetable.mjs --xh 2024150072      指定学号（接口没给时用）
 *   node scripts/collect-timetable.mjs --file <resp.json>   离线解析已抓到的 xskcb 响应
 *   node scripts/collect-timetable.mjs --replace            先清掉本来源旧数据再入库
 */
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { getEhallJar, openApp, appPost } from "./lib/ehall.mjs";
import { getJwkwJar, resolveWeek1Monday } from "./lib/jwkw.mjs";

// ---------- 配置 ----------

const APP_ID = "4770397878132218"; // 办事大厅「我的课表」
const SYS = "wdkb";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;
const HEADERS = { "x-wb-webapp-access-key": KEY, "Content-Type": "application/json" };

/**
 * 深圳大学作息时间（粤海、丽湖同一套）。
 * 来源：教务部通知中「1-2 节 08:30」「3-4 节 10:15」等写法 + 校内作息表。
 * 如遇调整，直接改这里，或用 data/timetable-periods.json 覆盖。
 */
const DEFAULT_PERIODS = {
  1: ["08:30", "09:10"],
  2: ["09:15", "09:55"],
  3: ["10:15", "10:55"],
  4: ["11:00", "11:40"],
  5: ["11:45", "12:25"],
  6: ["13:30", "14:10"],
  7: ["14:15", "14:55"],
  8: ["15:00", "15:40"],
  9: ["16:00", "16:40"],
  10: ["16:45", "17:25"],
  11: ["19:00", "20:20"],
  12: ["19:00", "20:20"],
  13: ["20:30", "21:45"],
  14: ["20:30", "21:45"],
};

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const DRY = argv.includes("--dry-run");
const NO_DB = argv.includes("--no-db") || DRY;
const FORCE_LOGIN = argv.includes("--relogin");
const WEEK1_OVERRIDE = opt("week1");
const TERM_OVERRIDE = opt("term");
const WEEK_OVERRIDE = opt("week");
const FILE = opt("file"); // 离线模式：直接吃一份 xskcb.do 的响应 JSON
const REPLACE = argv.includes("--replace");

// ---------- 日期工具 ----------

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** 周一=1 … 周日=7 */
const isoWeekday = (d) => d.getDay() === 0 ? 7 : d.getDay();

function loadPeriods() {
  const f = path.resolve("data/timetable-periods.json");
  if (fs.existsSync(f)) {
    try {
      return { ...DEFAULT_PERIODS, ...JSON.parse(fs.readFileSync(f, "utf-8")) };
    } catch {}
  }
  return DEFAULT_PERIODS;
}

// ---------- 采集 ----------

async function fetchTerm(jar, base) {
  const r = await appPost(jar, base, SYS, "jshkcb/dqxnxq.do");
  const row = r.datas?.dqxnxq?.rows?.[0];
  if (!row) throw new Error("拿不到当前学年学期");
  return { xndm: row.XNDM, xqdm: row.XQDM, code: row.DM, name: row.MC };
}

/** 当前教学周：dqzc 需要 学年 + 学期 + 当天日期，返回 row.ZC */
async function fetchCurrentWeek(jar, base, term) {
  try {
    const body = new URLSearchParams({ XN: term.xndm, XQ: term.xqdm, RQ: iso(new Date()) });
    const r = await appPost(jar, base, SYS, "jshkcb/dqzc.do", body.toString());
    const row = r.datas?.dqzc?.rows?.[0];
    const zc = Number(row?.ZC);
    return Number.isFinite(zc) && zc > 0 ? zc : null;
  } catch {
    return null;
  }
}

/** 学号：统一认证账号（482848）不是学号，课表接口要学号，从门户用户信息里取 */
async function fetchStudentId(jar) {
  try {
    const res = await fetch("https://ehall.szu.edu.cn/jsonp/userInfo.json", {
      headers: { Cookie: jar.headerFor("https://ehall.szu.edu.cn/") },
    });
    const txt = await res.text();
    const m = txt.match(/"userId"\s*:\s*"?(\d+)"?/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchSchedule(jar, base, term, week, xh) {
  const body = new URLSearchParams({
    XNXQDM: term.code,
    XH: xh || "",
    SKZC: String(week || 1),
  });
  const r = await appPost(jar, base, SYS, "xskcb/xskcb.do", body.toString());
  const rows = r.datas?.xskcb?.rows || [];
  if (!rows.length) throw new Error("课表为空：可能是学期参数不对，或本学期没有排课");
  return rows;
}

// ---------- 展开成日历事件 ----------

/** 学号 → 16 位哈希前缀。前端 claimTimetable 用同一算法，学号明文不进库 */
export function ownerKeyOf(xh) {
  if (!xh) return "-";
  return crypto.createHash("sha256").update(String(xh).trim()).digest("hex").slice(0, 16);
}

function expand(rows, week1Monday, periods, xh) {
  const events = [];
  const ownerKey = ownerKeyOf(xh);
  for (const r of rows) {
    const mask = String(r.SKZC || "");
    const weekday = Number(r.SKXQ);
    const ks = Number(r.KSJC), js = Number(r.JSJC);
    const p1 = periods[ks], p2 = periods[js];
    if (!mask || !weekday || !p1 || !p2) continue;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== "1") continue;
      const week = i + 1;
      const date = addDays(week1Monday, (week - 1) * 7 + (weekday - 1));

      events.push({
        kind: "other",
        title: r.KCM,
        start_at: `${iso(date)}T${p1[0]}:00+08:00`,
        end_at: `${iso(date)}T${p2[1]}:00+08:00`,
        all_day: false,
        course: r.KCM,
        location: r.JASMC || null,
        note: `第${week}周 · ${ks}-${js}节 · ${r.SKJS || ""}${r.KXH ? ` · 课序${r.KXH}` : ""}`.trim(),
        scope: "personal",
        source: "ehall",
        // 学号哈希放在第二段，作为前端「认领」时的归属凭据
        source_url: `ehall://xskcb/${ownerKey}/${r.JXBID}/${week}/${weekday}/${ks}-${js}`,
        link: null,
      });
    }
  }
  return events.sort((a, b) => a.start_at.localeCompare(b.start_at));
}

// ---------- 入库 ----------

async function existingKeys() {
  const keys = new Set();
  let offset = 0;
  const size = 1000;
  for (;;) {
    const res = await fetch(
      `${TABLE}?select=source_url&source=eq.ehall&limit=${size}&offset=${offset}`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`读取已有课表失败 ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    for (const r of rows) if (r.source_url) keys.add(r.source_url);
    if (rows.length < size) break;
    offset += size;
  }
  return keys;
}

/** 清掉本来源的旧数据（日期锚点变更后必须整批重来） */
async function clearAll() {
  const res = await fetch(`${TABLE}?source=eq.ehall`, {
    method: "DELETE",
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`清理旧课表失败 ${res.status}: ${await res.text()}`);
}

async function ingest(events, batch = 100) {
  const exists = await existingKeys();
  const todo = events.filter((e) => !exists.has(e.source_url));
  console.log(`库里已有 ${exists.size} 条课表事件，本次新增 ${todo.length} 条`);
  if (!todo.length) return { added: 0, failed: 0, skipped: events.length };

  let added = 0, failed = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const res = await fetch(TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(chunk),
    });
    if (res.ok) added += chunk.length;
    else {
      failed += chunk.length;
      console.error(`\n  批次 ${i}-${i + chunk.length} 失败: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    process.stdout.write(`\r  进度 ${Math.min(i + batch, todo.length)}/${todo.length} 新增 ${added} 失败 ${failed}`);
  }
  console.log();
  return { added, failed, skipped: exists.size };
}

// ---------- 主流程 ----------

async function main() {
  let term, currentWeek, rows, termCode, termName;
  let xh = opt("xh") || null;

  if (FILE) {
    // 离线模式：用已抓下来的接口响应，不联网
    const j = JSON.parse(fs.readFileSync(path.resolve(FILE), "utf-8"));
    rows = j.datas?.xskcb?.rows || [];
    if (!rows.length) throw new Error("JSON 里没有 xskcb 数据");
    termCode = TERM_OVERRIDE || rows[0].XNXQDM;
    termName = termCode;
    currentWeek = Number(WEEK_OVERRIDE) || null;
    console.log(`离线模式：${FILE}，${rows.length} 行`);
  } else {
    const { jar, cached } = await getEhallJar({ force: FORCE_LOGIN });
    console.log(`办事大厅会话：${cached ? "复用缓存" : "新登录"}`);

    const app = await openApp(jar, APP_ID);
    term = await fetchTerm(jar, app.base);
    termCode = TERM_OVERRIDE || term.code;
    termName = term.name || termCode;
    console.log(`学期：${termName}（${termCode}）`);

    currentWeek = Number(WEEK_OVERRIDE) || (await fetchCurrentWeek(jar, app.base, term));
    console.log(`当前教学周：${currentWeek ?? "未知"}`);

    xh = xh || (await fetchStudentId(jar));
    console.log(`学号：${xh ?? "（接口没给，按会话身份取）"}`);
    if (!xh) console.warn("警告：没取到学号，若课表为空请用 --xh <学号> 指定；认领也会失效");

    rows = await fetchSchedule(jar, app.base, { code: termCode }, currentWeek || 1, xh);
  }

  console.log(`课表行：${rows.length} 条（同一门课可能拆成多段）`);

  // 第 1 周周一：以教务（jwkw）的周次为准，它按校历算并且能交叉验证。
  // 离线模式（--file）没有会话，退回用 --week1 或 --week 推算。
  let week1Monday;
  if (WEEK1_OVERRIDE) {
    week1Monday = new Date(`${WEEK1_OVERRIDE}T00:00:00`);
    console.log(`第 1 周周一：${iso(week1Monday)}（--week1 指定）`);
  } else if (FILE) {
    if (!currentWeek) throw new Error("离线模式需要 --week1 或 --week 来定位第 1 周");
    const today = new Date();
    week1Monday = addDays(today, -((currentWeek - 1) * 7 + (isoWeekday(today) - 1)));
    console.log(`第 1 周周一：${iso(week1Monday)}（按 --week 推算）`);
  } else {
    const jw = await getJwkwJar({ force: FORCE_LOGIN });
    const r = await resolveWeek1Monday(jw.jar);
    week1Monday = r.week1Monday;
    currentWeek = r.currentWeek;
    console.log(`第 1 周周一：${iso(week1Monday)}（教务校历，当前第 ${currentWeek} 周）`);
  }

  const periods = loadPeriods();
  const events = expand(rows, week1Monday, periods, xh);
  console.log(`归属键：${ownerKeyOf(xh)}（学号哈希前 16 位，用于认领）`);
  const courses = [...new Set(rows.map((r) => r.KCM))];
  console.log(`课程 ${courses.length} 门 → 展开 ${events.length} 个上课事件`);

  const dir = path.resolve("data/timetable");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `timetable-${termCode}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ term: termCode, termName, week1Monday: iso(week1Monday), currentWeek, courses, events }, null, 2),
    "utf-8"
  );
  console.log(`已写入 ${path.relative(process.cwd(), out)}`);

  if (DRY) {
    console.log("\n--dry-run 前 5 条：");
    console.log(JSON.stringify(events.slice(0, 5), null, 2));
    return;
  }
  if (NO_DB) return;

  if (REPLACE) {
    console.log("--replace：先清掉库里 source=ehall 的旧课表……");
    await clearAll();
  }

  const res = await ingest(events);
  console.log(`入库完成：新增 ${res.added}，失败 ${res.failed}，已存在 ${res.skipped}`);
}

main().catch((e) => {
  console.error("采集失败：", e.message);
  process.exit(1);
});
