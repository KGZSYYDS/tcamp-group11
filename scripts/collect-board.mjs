#!/usr/bin/env node
/**
 * 公文通采集器（公共数据层）
 *
 * 站点：https://www1.szu.edu.cn/board/
 * 全站需统一身份认证（CAS），本脚本用你本人的账号登录一次拿会话，再批量抓取。
 * 凭据存在 data/.credentials.json（gitignore），不打印、不进仓库。
 *
 * 用法：
 *   node scripts/collect-board.mjs --login                 # 自动登录 + 抓全部栏目
 *   node scripts/collect-board.mjs --login --cats 讲座,教务  # 只抓指定栏目
 *   node scripts/collect-board.mjs --login --list-only     # 只抓列表，不抓详情（快）
 *   node scripts/collect-board.mjs --cookie "<cookie>"     # 用现成 Cookie
 *
 * 输出：data/board/notices-YYYYMMDD.json
 */

import fs from "fs";
import path from "path";
import { casLogin } from "./lib/cas.mjs";
import { loadCredentials, saveCookie, loadCookie, ensureDataDir } from "./lib/session.mjs";

const ORIGIN = "https://www1.szu.edu.cn";
const BOARD = `${ORIGIN}/board/`;
const SERVICE = "http://www1.szu.edu.cn/manage/caslogin.asp?rurl=%2Fboard%2F";

// 首页导航里的全部栏目（实测均可访问）
const ALL_CATS = ["置顶", "教务", "学工", "科研", "行政", "讲座", "生活", "会议"];

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const CATS = (opt("cats") || ALL_CATS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const DELAY = Number(opt("delay", "500"));
const OUT_DIR = path.resolve(opt("out", "data/board"));
const LIST_ONLY = has("list-only");
const NO_LOGIN = has("no-login");
const LIMIT = Number(opt("limit", "0")) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 编码 ----------

/** 站点是 GB2312/GBK，统一按 gb18030 解码（GBK 超集） */
function decode(buf, contentType = "") {
  const declared = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1]?.toLowerCase();
  const order =
    declared && /gb2312|gbk|gb18030/.test(declared) ? ["gb18030"] : ["gb18030", "utf-8"];
  for (const enc of order) {
    const t = new TextDecoder(enc).decode(buf);
    if ((t.match(/\uFFFD/g) || []).length <= 3) return t;
  }
  return new TextDecoder("gb18030").decode(buf);
}

/** 中文参数必须按 GBK 编码，UTF-8 会被服务端当成无效栏目 */
function gbkEncode(str) {
  // Node 没有内置 GBK 编码器，用查表法：常用栏目名硬编码 + 兜底走 URLSearchParams
  const table = {
    置顶: "%D6%C3%B6%A5",
    教务: "%BD%CC%CE%F1",
    学工: "%D1%A7%B9%A4",
    科研: "%BF%C6%D1%D0",
    行政: "%D0%D0%D5%FE",
    讲座: "%BD%B2%D7%F9",
    生活: "%C9%FA%BB%EE",
    会议: "%BB%E1%D2%E9",
  };
  return table[str] || encodeURIComponent(str);
}

// ---------- HTTP ----------

let COOKIE = "";

async function get(url, { retry = 2 } = {}) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          Cookie: COOKIE,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
          Referer: BOARD,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        redirect: "follow",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, url: res.url, html: decode(buf, res.headers.get("content-type") || "") };
    } catch (e) {
      if (i === retry) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

function isLoginPage(r) {
  if (/authserver\.szu\.edu\.cn/.test(r.url)) return true;
  return /type=["']password["']/i.test(r.html) && /统一身份认证|authserver/.test(r.html);
}

// ---------- 解析 ----------

const ENTITIES = [
  [/&nbsp;/g, " "], [/&amp;/g, "&"], [/&lt;/g, "<"], [/&gt;/g, ">"],
  [/&quot;/g, '"'], [/&#39;/g, "'"], [/&ldquo;/g, "“"], [/&rdquo;/g, "”"],
];

function stripTags(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  for (const [re, rep] of ENTITIES) s = s.replace(re, rep);
  return s.replace(/[ \t\u3000]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function normalizeDate(s) {
  if (!s) return null;
  const m = String(s).match(/(20\d\d)[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * 列表页解析。真实结构（2026-11 实测）：
 * <tr><td>序号</td><td><a href="?infotype=教务">教务</a></td>
 *     <td><a href=# onclick="...from_username.value='单位'...">单位</a></td>
 *     <td align="left"><b>·</b><a target=_blank class=fontcolor3 href="view.asp?id=586511">标题</a></td>
 *     <td></td><td>2026-10-30</td></tr>
 */
function parseList(html, fallbackCat) {
  const out = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const link = row.match(/href="view\.asp\?id=(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/i);
    if (!link) continue;

    const id = link[1];
    const title = stripTags(link[2]).replace(/\s+/g, " ").trim();
    if (!title) continue;

    const dept = (row.match(/from_username\.value='([^']*)'/) || [])[1]
      || (row.match(/from_username\.value="([^"]*)"/) || [])[1]
      || null;

    const cat = (row.match(/<a href="\?infotype=([^"]+)"/) || [])[1] || fallbackCat;

    // 取行内最后一个日期（单位名里可能也有数字）
    const dates = row.match(/20\d\d-\d{1,2}-\d{1,2}/g) || [];
    const publishedAt = normalizeDate(dates[dates.length - 1]);

    out.push({
      id,
      url: `${BOARD}view.asp?id=${id}`,
      title,
      category: cat ? stripTags(cat).trim() : null,
      department: dept ? stripTags(dept).trim() : null,
      publishedAt,
    });
  }
  // 同一页可能重复（置顶区 + 正文区），按 id 去重
  const seen = new Set();
  return out.filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
}

/**
 * 详情页解析。元信息行：
 * <font color=#808080>化学与环境工程学院　2026/11/8 11:25:00</font>
 * 正文：<td height="300" valign=top> ... </td>
 */
function parseDetail(html) {
  const meta = html.match(/<font color=#?808080>([\s\S]{0,200}?)<\/font>/i);
  let department = null;
  let publishedAt = null;
  if (meta) {
    const raw = stripTags(meta[1]);
    const dm = raw.match(/(20\d\d\/\d{1,2}\/\d{1,2})/);
    if (dm) {
      publishedAt = normalizeDate(dm[1].replace(/\//g, "-"));
      // 形如「化学与环境工程学院　2026/11/8 11:25:00」，日期与时间都要剥掉
      department =
        raw
          .replace(dm[1], "")
          .replace(/\d{1,2}:\d{2}(:\d{2})?/, "")
          .replace(/[\s\u3000]+/g, " ")
          .trim() || null;
    } else {
      department = raw.trim() || null;
    }
  }

  // 标题
  const h1 =
    (html.match(/<span[^>]*font-size:\s*25px[^>]*>([\s\S]{0,200}?)<\/span>/i) || [])[1] ||
    (html.match(/<title>([\s\S]{0,200}?)<\/title>/i) || [])[1] ||
    "";
  const title = stripTags(h1).replace(/[-—–]\s*深圳大学内部网\s*$/, "").trim();

  // 正文：从 <td height="300" 开始
  const bodyStart = html.search(/<td\s+height="?300"?[^>]*>/i);
  let body = bodyStart >= 0 ? html.slice(bodyStart) : html;
  body = body.replace(/<\/body>[\s\S]*$/i, "");

  let content = stripTags(body);
  // 去掉浏览记录（含真实姓名学号，属于个人隐私，不采集）
  content = content.replace(/（[^）]{2,20}\d{10,}[^）]*浏览）/g, "");
  content = content.replace(/版权所有[\s\S]*$/m, "").trim();

  return { title, department, publishedAt, content: content.slice(0, 6000) };
}

// ---------- 登录 ----------

async function ensureSession() {
  const manual = opt("cookie");
  if (manual) {
    COOKIE = manual.trim();
    return "手动 Cookie";
  }

  const cached = loadCookie();
  if (cached && !NO_LOGIN) {
    COOKIE = cached;
    const probe = await get(BOARD);
    if (!isLoginPage(probe)) {
      const age = (Date.now() - fs.statSync(path.resolve("data/.cookie.txt")).mtimeMs) / 3600000;
      return `缓存 Cookie（${age.toFixed(1)} 小时前）`;
    }
  }

  if (NO_LOGIN) throw new Error("Cookie 已失效，且指定了 --no-login");

  // loadCredentials 改成了异步（密码不落盘，可能要交互式读一次），
  // 这里原先的同步调用会拿到 Promise 导致登录用到 undefined。
  const cred = await loadCredentials();
  if (!cred) {
    throw new Error(
      "没有可用凭据。用环境变量传入：SZU_USER=<学号> SZU_PASS=<密码> node scripts/collect-board.mjs"
    );
  }

  const r = await casLogin(cred.username, cred.password, SERVICE);
  COOKIE = r.cookie;
  saveCookie(COOKIE);
  return `重新登录（ticket ${r.ticket?.slice(0, 16) || "-"}）`;
}

// ---------- 主流程 ----------

async function main() {
  ensureDataDir();
  console.log(`会话：${await ensureSession()}`);

  const first = await get(BOARD);
  if (isLoginPage(first)) {
    console.error("登录态无效：请求被重定向到统一身份认证。");
    process.exit(2);
  }

  const all = new Map(); // id -> item
  for (const cat of CATS) {
    const url = `${BOARD}infolist.asp?infotype=${gbkEncode(cat)}`;
    const r = await get(url);
    if (isLoginPage(r)) {
      console.error(`抓「${cat}」时掉登录，中断。`);
      break;
    }
    const items = parseList(r.html, cat);
    for (const it of items) {
      const prev = all.get(it.id);
      if (!prev) all.set(it.id, it);
      else if (!prev.category && it.category) prev.category = it.category;
    }
    const total = (r.html.match(/共(\d+)条/) || [])[1] || "?";
    console.log(`  ${cat.padEnd(3)} 共 ${String(total).padStart(4)} 条 → 解析 ${items.length}，累计 ${all.size}`);
    await sleep(DELAY);
  }

  const list = Array.from(all.values()).sort((a, b) =>
    (b.publishedAt || "").localeCompare(a.publishedAt || "")
  );
  console.log(`\n列表合计 ${list.length} 条`);

  // 已抓过的详情（按 id 增量）
  const seenFile = path.join(OUT_DIR, "seen.json");
  const seen = fs.existsSync(seenFile)
    ? new Set(JSON.parse(fs.readFileSync(seenFile, "utf-8")))
    : new Set();

  const details = [];
  if (!LIST_ONLY) {
    const pending = list.filter((it) => !seen.has(it.id));
    const todo = pending.slice(0, LIMIT);
    console.log(`需要抓详情 ${todo.length} 条（列表 ${list.length}，已抓过 ${list.length - pending.length}）`);
    let i = 0;
    for (const it of todo) {
      i++;
      process.stdout.write(`\r  详情 ${i}/${todo.length}  ${it.id}`);
      try {
        const r = await get(it.url);
        if (isLoginPage(r)) {
          console.error("\n掉登录，停止抓详情。");
          break;
        }
        const d = parseDetail(r.html);
        Object.assign(it, {
          title: d.title && d.title.length >= 4 ? d.title : it.title,
          department: d.department || it.department,
          publishedAt: d.publishedAt || it.publishedAt,
          content: d.content,
        });
        details.push(it);
        seen.add(it.id);
      } catch (e) {
        process.stdout.write(`  ✗ ${e.message}\n`);
      }
      await sleep(DELAY);
    }
    process.stdout.write("\n");
  }

  const out = LIST_ONLY ? list : details.length > 0 ? details : list;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /**
   * --list-only 单独命名，且**不动** notices-latest.json。
   *
   * 原因：latest 是下游 ingest 的默认输入，它要的是「带正文」的那份。
   * 一次 list-only 跑完就把 1.5MB 的正文版覆盖成 150KB 的纯列表，
   * 截止时间就全抽不出来了 —— 这个坑踩过一次。
   */
  if (LIST_ONLY) {
    fs.writeFileSync(path.join(OUT_DIR, `notices-list-${stamp}.json`), JSON.stringify(out, null, 2), "utf-8");
    console.log(`\n完成（只抓列表）：${out.length} 条`);
    console.log(`输出：${path.join(OUT_DIR, `notices-list-${stamp}.json`)}`);
    return;
  }

  fs.writeFileSync(path.join(OUT_DIR, `notices-${stamp}.json`), JSON.stringify(out, null, 2), "utf-8");

  /**
   * notices-latest.json 是「累积快照」，不是「本次增量」。
   *
   * 下游 ingest 靠 latest 抽截止，而采集是增量的（seen.json 记住已抓过的 id）。
   * 如果 latest 只写本次新抓的几条，昨天那 500 条带正文的就在默认输入里消失了，
   * 表现为「今天再跑一次，截止时间少了一半」。
   */
  const latestFile = path.join(OUT_DIR, "notices-latest.json");
  let merged = out;
  if (fs.existsSync(latestFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(latestFile, "utf-8"));
      if (Array.isArray(prev)) {
        const map = new Map(prev.map((x) => [String(x.id), x]));
        for (const it of out) map.set(String(it.id), it); // 新的覆盖旧的
        // 先按发布日期，再按 id 倒序：同一天内新发的排前面
        merged = Array.from(map.values()).sort(
          (a, b) =>
            (b.publishedAt || "").localeCompare(a.publishedAt || "") ||
            String(b.id).localeCompare(String(a.id))
        );
      }
    } catch {
      /* 旧文件坏了就以本次为准 */
    }
  }

  fs.writeFileSync(latestFile, JSON.stringify(merged, null, 2), "utf-8");
  fs.writeFileSync(seenFile, JSON.stringify(Array.from(seen)), "utf-8");

  const withContent = merged.filter((x) => x.content).length;
  console.log(`\n本次 ${out.length} 条（新抓详情 ${details.length}），累积 ${merged.length} 条，带正文 ${withContent} 条`);
  console.log(`输出：${path.join(OUT_DIR, `notices-${stamp}.json`)}`);
}

main().catch((e) => {
  console.error("采集失败：", e.message);
  process.exit(1);
});
