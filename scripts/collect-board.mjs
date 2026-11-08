#!/usr/bin/env node
/**
 * 公文通批量采集器（公共数据层）
 *
 * 公文通 www1.szu.edu.cn/board/ 全站走统一身份认证（CAS），没有公开 API。
 * 本脚本不保存账号密码，只使用「你本人在浏览器里登录后拿到的 Cookie」：
 *
 *   1. 浏览器登录 https://www1.szu.edu.cn/board/
 *   2. F12 → Network → 刷新 → 任意请求 → Request Headers → 复制 Cookie 整行
 *   3. node scripts/collect-board.mjs --cookie "<粘贴>" --pages 5
 *
 * 输出的 notices-*.json 可直接走 app/api/import 入库（scope=school）。
 *
 * 用法：
 *   node scripts/collect-board.mjs --cookie "<cookie>" --pages 5
 *   node scripts/collect-board.mjs --cookie-file data/cookie.txt
 *   node scripts/collect-board.mjs --from-html saved.html   # 离线调试解析
 *   node scripts/collect-board.mjs --cookie "..." --save-raw  # 存原始 HTML 便于调选择器
 */

import fs from "fs";
import path from "path";

const BOARD = "https://www1.szu.edu.cn/board/";
const ORIGIN = "https://www1.szu.edu.cn";

// ---------- 参数 ----------

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const PAGES = Number(opt("pages", "3"));
const OUT_DIR = path.resolve(opt("out", "data/board"));
const RAW_DIR = path.join(OUT_DIR, "raw");
const DELAY = Number(opt("delay", "800"));
const SAVE_RAW = flag("save-raw");
const FROM_HTML = opt("from-html");
const DRY = flag("dry-run");

function readCookie() {
  const inline = opt("cookie");
  if (inline) return inline.trim();
  const file = opt("cookie-file");
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf-8").trim();
  if (process.env.SZU_BOARD_COOKIE) return process.env.SZU_BOARD_COOKIE.trim();
  return "";
}

// ---------- 抓取 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 老 ASP 站点返回 GBK，且部分页面 Content-Type 不声明编码 —— 按字节嗅探 */
function decodeBody(buf, contentType = "") {
  const declared = (contentType.match(/charset=["']?([\w-]+)/i) || [])[1];
  const tryOrder = [];
  if (declared) {
    const d = declared.toLowerCase();
    tryOrder.push(d === "gb2312" || d === "gbk" ? "gb18030" : d);
  }
  tryOrder.push("utf-8", "gb18030");

  for (const enc of tryOrder) {
    try {
      const text = new TextDecoder(enc).decode(buf);
      // U+FFFD 过多说明解码失败
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad <= Math.max(2, text.length * 0.002)) return text;
    } catch {
      /* 该编码不可用，继续 */
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}

async function fetchText(url, cookie) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
          Referer: BOARD,
        },
        redirect: "follow",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = decodeBody(buf, res.headers.get("content-type") || "");
      return { status: res.status, finalUrl: res.url, html: text, buf };
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(1500);
    }
  }
}

function isLoginPage(r) {
  if (/authserver\.szu\.edu\.cn/.test(r.finalUrl)) return true;
  const hasPwd = /type=["']password["']/i.test(r.html);
  const hasCas = /统一身份认证|authserver|账号登录/.test(r.html);
  return hasPwd && hasCas;
}

// ---------- 解析 ----------

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function absUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * 列表页 → 详情链接。
 * 不写死选择器：公文通是 ASP 站点，翻版后结构会变，按特征判定更耐改。
 * 同时记录条目附近的日期文本，作为 publishedAt 的兜底。
 */
function findDetailLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const title = stripTags(m[2]).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 150) continue;
    if (/^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
    if (/logout|login|authserver|captcha/i.test(href)) continue;

    // 详情特征：info/ 路径、含 id 参数、detail/view/show/article 等
    const looksDetail = /(\/info\/|\/board\/|\/\d{3,}\.htm|[?&](id|ID|boardid|infoid)=\d+|detail|view|article|notice|content|show)/i.test(href);
    if (!looksDetail) continue;

    const url = absUrl(href, baseUrl);
    if (!url || !url.startsWith(ORIGIN)) continue;
    if (url.replace(/\/$/, "") === baseUrl.replace(/\/$/, "")) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // 从 anchor 之后 300 字符内找日期（列表常见「标题……2026-11-08」布局）
    const tail = stripTags(html.slice(m.index + m[0].length, m.index + m[0].length + 300));
    const date = (tail.match(/(20\d\d)[-/年.](\d{1,2})[-/月.](\d{1,2})/) || [])[0] || null;

    out.push({ url, title, publishedAt: normalizeDate(date) });
  }
  return out;
}

function normalizeDate(s) {
  if (!s) return null;
  const m = String(s).match(/(20\d\d)[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 翻页链接：优先「下一页」文案，其次 page=N / Page=N / pageno */
function findNextLinks(html, baseUrl) {
  const out = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = stripTags(m[2]).replace(/\s+/g, "");
    const isNext = /下一页|下页|后一页|»|›|next/i.test(text);
    const isPaged = /[?&](page|Page|pageno|pageNo|p)=\d+/i.test(href);
    if (!isNext && !isPaged) continue;
    const url = absUrl(href, baseUrl);
    if (url && url.startsWith(ORIGIN)) out.add(url);
  }
  return Array.from(out);
}

/** 详情页 → 标题 / 发布单位 / 日期 / 正文 */
function parseDetail(html, fallbackTitle) {
  const titleFromPage =
    (html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i) ||
      html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || "";
  let title = stripTags(titleFromPage).trim();
  title = title.replace(/[-_|—–]\s*(深圳大学|公文通|内部网).*$/, "").trim();
  if (title.length < 4) title = fallbackTitle;

  const text = stripTags(html);

  // 发布单位：常见「发布单位：xxx」「发文单位：xxx」
  const dept =
    (text.match(/(?:发布单位|发文单位|信息来源|来源)[：:]\s*([^\n]{2,30})/) || [])[1] || null;

  // 日期：优先带「日期/时间」标签，其次正文首个日期
  const pub =
    normalizeDate((text.match(/(?:发布日期|发布时间|日期|时间)[：:]\s*(20\d\d[-/年.]\d{1,2}[-/月.]\d{1,2})/) || [])[1]) ||
    normalizeDate((text.match(/(20\d\d[-/年.]\d{1,2}[-/月.]\d{1,2})/) || [])[1]);

  // 正文：去掉页头页脚后的中段
  const bodyMatch =
    html.match(/<div[^>]*class=["'][^"']*(?:content|article|detail|main|con)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/(?:div|body)>/i);
  const content = stripTags(bodyMatch ? bodyMatch[1] : html).slice(0, 8000);

  return {
    title: title || fallbackTitle,
    department: dept ? dept.trim() : null,
    publishedAt: pub,
    content,
  };
}

// ---------- 主流程 ----------

function saveJson(name, data) {
  if (DRY) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2), "utf-8");
}

async function main() {
  // 离线解析调试
  if (FROM_HTML) {
    const html = fs.readFileSync(FROM_HTML, "utf-8");
    const links = findDetailLinks(html, BOARD);
    const next = findNextLinks(html, BOARD);
    console.log(`解析 ${FROM_HTML}`);
    console.log(`  详情链接 ${links.length} 条，翻页链接 ${next.length} 个`);
    links.slice(0, 10).forEach((l) => console.log(`  - ${l.publishedAt || "----"}  ${l.title}`));
    next.slice(0, 5).forEach((n) => console.log(`  → ${n}`));
    return;
  }

  const cookie = readCookie();
  if (!cookie) {
    console.error(
      [
        "缺少 Cookie。公文通需要统一身份认证，脚本不保存账号密码。",
        "",
        "获取方式：浏览器登录 https://www1.szu.edu.cn/board/ → F12 → Network →",
        "任意请求 → Request Headers → 复制 Cookie 整行，然后：",
        '  node scripts/collect-board.mjs --cookie "<粘贴>"',
        "",
        "也可写入文件后 --cookie-file data/cookie.txt（data/ 已在 .gitignore 内）。",
      ].join("\n")
    );
    process.exit(1);
  }

  console.log(`抓取起点 ${BOARD}，最多 ${PAGES} 页，间隔 ${DELAY}ms`);

  const first = await fetchText(BOARD, cookie);
  if (isLoginPage(first)) {
    console.error(
      `\nCookie 已失效：请求被重定向到统一身份认证（${first.finalUrl}）。\n重新登录后复制新的 Cookie 再跑。`
    );
    process.exit(2);
  }
  if (first.status !== 200) {
    console.error(`首页返回 ${first.status}，检查网络或 Cookie。`);
    process.exit(3);
  }

  if (SAVE_RAW) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, "list-1.html"), first.html, "utf-8");
  }

  // 队列翻页
  const queue = [BOARD];
  const visitedPages = new Set();
  const details = new Map(); // url → {title, publishedAt}

  for (const n of findNextLinks(first.html, BOARD)) queue.push(n);

  let pageNo = 0;
  while (queue.length && pageNo < PAGES) {
    const pageUrl = queue.shift();
    if (visitedPages.has(pageUrl)) continue;
    visitedPages.add(pageUrl);

    const r = pageNo === 0 ? first : await fetchText(pageUrl, cookie);
    pageNo++;
    if (isLoginPage(r)) {
      console.error(`\n第 ${pageNo} 页被踢回登录页，Cookie 中途失效。已采集 ${details.size} 条。`);
      break;
    }
    if (SAVE_RAW) {
      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.writeFileSync(path.join(RAW_DIR, `list-${pageNo}.html`), r.html, "utf-8");
    }

    const links = findDetailLinks(r.html, r.finalUrl || pageUrl);
    let added = 0;
    for (const l of links) {
      if (!details.has(l.url)) {
        details.set(l.url, l);
        added++;
      }
    }
    console.log(`  第 ${pageNo} 页：新增 ${added} 条（累计 ${details.size}）`);

    for (const n of findNextLinks(r.html, r.finalUrl || pageUrl)) {
      if (!visitedPages.has(n)) queue.push(n);
    }
    if (queue.length && pageNo < PAGES) await sleep(DELAY);
  }

  if (details.size === 0) {
    console.error(
      "\n没有解析到任何通知条目。页面结构可能已变，用 --save-raw 保存原始 HTML，再用 --from-html 调试。"
    );
    process.exit(4);
  }

  // 逐个抓详情
  const knownFile = path.join(OUT_DIR, "seen.json");
  const seen = fs.existsSync(knownFile)
    ? new Set(JSON.parse(fs.readFileSync(knownFile, "utf-8")))
    : new Set();

  const items = [];
  let i = 0;
  for (const [url, meta] of details) {
    i++;
    if (seen.has(url)) {
      process.stdout.write(`\r  详情 ${i}/${details.size}（已采集过，跳过）`);
      continue;
    }
    process.stdout.write(`\r  详情 ${i}/${details.size}`);
    try {
      const r = await fetchText(url, cookie);
      if (isLoginPage(r)) break;
      const d = parseDetail(r.html, meta.title);
      items.push({
        url,
        title: d.title,
        department: d.department,
        publishedAt: d.publishedAt || meta.publishedAt,
        content: d.content,
        collectedAt: new Date().toISOString(),
      });
      seen.add(url);
    } catch (e) {
      console.error(`\n  ${url} 抓取失败：${e.message}`);
    }
    await sleep(DELAY);
  }
  process.stdout.write("\n");

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  saveJson(`notices-${stamp}.json`, items);
  saveJson("seen.json", Array.from(seen));

  console.log(`\n完成：新增 ${items.length} 条，去重后总计 ${seen.size} 条`);
  if (!DRY) console.log(`输出目录：${OUT_DIR}`);
  if (items.length > 0) {
    console.log("\n下一步：POST 到 app/api/import，或直接写库（scope=school）");
  }
}

main().catch((e) => {
  console.error("采集失败：", e);
  process.exit(99);
});
