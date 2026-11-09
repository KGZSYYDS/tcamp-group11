#!/usr/bin/env node
/**
 * 深大官网采集器（公共数据层，**不需要登录**）
 *
 * 站点：https://www.szu.edu.cn/
 * 与公文通的分工：
 *   - 公文通（www1 /board/）是「校内通知」，要 CAS；
 *   - 官网是「对外公开的公告、学术讲座、学生活动」，谁都能看，所以采集器不需要凭证。
 *
 * 输出与 collect-board.mjs 完全同构（id / url / title / category / department /
 * publishedAt / content），这样 ingest-notices.mjs 一份代码能吃两种源，入库时用
 * source 字段区分（board / web）。
 *
 * 用法：
 *   node scripts/collect-web.mjs                     # 全部栏目，每栏 2 页
 *   node scripts/collect-web.mjs --pages 5
 *   node scripts/collect-web.mjs --channels tzgg,xsdt
 *   node scripts/collect-web.mjs --no-detail        # 只抓列表（快）
 *   node scripts/collect-web.mjs --dry              # 只打印解析结果到 stdout
 *
 * 输出：data/web/notices-web-YYYYMMDD.json + notices-web-latest.json
 */

import fs from "fs";
import path from "path";

const ORIGIN = "https://www.szu.edu.cn";

/**
 * 栏目表。`base` 是列表根，`${base}.htm` 是第一页，`${base}/N.htm` 是第 N 页
 * （Visual SiteBuilder 的分页规则，实测 /index/tzgg/1.htm 起为归档页）。
 */
const CHANNELS = {
  tzgg: { base: `${ORIGIN}/index/tzgg`, name: "通知公告" },
  xsdt: { base: `${ORIGIN}/kxyj/xsdt`, name: "学术动态" },
  sdxw: { base: `${ORIGIN}/index/sdxw`, name: "深大新闻" },
};

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const PAGES = Number(opt("pages", "2")) || 1;
const DELAY = Number(opt("delay", "400"));
const NO_DETAIL = has("no-detail");
const DRY = has("dry");
const OUT_DIR = path.resolve(opt("out", "data/web"));
const CHANNELS_SEL = (opt("channels") || Object.keys(CHANNELS).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter((k) => CHANNELS[k]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 站点很割裂：<meta charset="utf-8"> 但实际字节是 GBK。
 * 先用 gb18030 解，替换字符过多再回落 utf-8 —— 和 collect-board 同一套判断。
 */
function decode(buf) {
  const gb = new TextDecoder("gb18030").decode(buf);
  const bad = (gb.match(/\uFFFD/g) || []).length;
  return bad > 5 ? new TextDecoder("utf-8").decode(buf) : gb;
}

async function get(url, { retry = 2 } = {}) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        redirect: "follow",
      });
      return {
        status: res.status,
        url: res.url,
        html: decode(Buffer.from(await res.arrayBuffer())),
      };
    } catch (e) {
      if (i === retry) throw e;
      await sleep(900 * (i + 1));
    }
  }
}

const ENTITIES = [
  [/&nbsp;/g, " "], [/&amp;/g, "&"], [/&lt;/g, "<"], [/&gt;/g, ">"],
  [/&quot;/g, '"'], [/&#39;/g, "'"], [/&ldquo;/g, "“"], [/&rdquo;/g, "”"],
  [/&mdash;/g, "—"], [/&hellip;/g, "…"],
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

function absUrl(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  // 列表页里的相对路径是相对「栏目目录」的，统一用站点根解更稳
  return new URL(href, `${ORIGIN}/`).href;
}

/**
 * 列表页解析。实测结构（2026-11）：
 * <li class="wow fadeInUp" ...>
 *   <a href="../info/1154/21034.htm" class="con">
 *     <div class="bg"><img ...></div>
 *     <div class="date"><div class="d1">2026</div><div class="d2">08-14</div></div>
 *     <h4>关于推荐作品参加…</h4>
 *   </a>
 * </li>
 *
 * 有几种变体（一部分栏目把日期放 <span>、一部分条目直接连到公众号），
 * 所以不按固定标签硬匹配，而是在每个 <li> 里分别找 href / 年月日 / 标题。
 */
function parseList(html, channelKey) {
  const out = [];
  const lis = html.match(/<li[\s\S]*?<\/li>/gi) || [];

  for (const li of lis) {
    const href = (li.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*con[^"]*"/i) || [])[1]
      || (li.match(/<a[^>]+href="([^"]+)"[^>]*>/i) || [])[1];
    if (!href) continue;
    const url = absUrl(href);
    if (!url || url === `${ORIGIN}/`) continue;
    if (/^javascript:/i.test(href)) continue;

    let title = "";
    const h4 = li.match(/<h4[^>]*>([\s\S]{0,300}?)<\/h4>/i);
    if (h4) title = stripTags(h4[1]);
    if (!title) {
      const aText = li.match(/<a[^>]*>([\s\S]{0,300}?)<\/a>/i);
      if (aText) title = stripTags(aText[1]);
    }
    title = title.replace(/\s+/g, " ").trim();
    if (!title || title.length < 4) continue;

    // 日期：优先 d1/d2 结构，退回整段里的 YYYY-MM-DD / YYYY年M月D日
    let publishedAt = null;
    const y = li.match(/<div[^>]*class="[^"]*d1[^"]*"[^>]*>\s*(\d{4})\s*<\/div>/i);
    const md = li.match(/<div[^>]*class="[^"]*d2[^"]*"[^>]*>\s*(\d{2})-(\d{2})\s*<\/div>/i);
    if (y && md) publishedAt = `${y[1]}-${md[1]}-${md[2]}`;
    if (!publishedAt) {
      const m = li.match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
      if (m) publishedAt = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }

    out.push({
      id: `${channelKey}:${url.replace(ORIGIN, "")}`,
      url,
      title: title.slice(0, 200),
      category: CHANNELS[channelKey].name,
      department: null,
      publishedAt,
      channel: channelKey,
    });
  }

  /**
   * 只留有发布日期的条目。
   *
   * 这一条不是「顺手过滤」，而是列表页里唯一可靠的分界线：导航菜单、
   * 页脚、栏目跳转的 <li> 全都没有日期，正文列表每一条都有。实测一页
   * 会捞出 50+ 个 <li>，真正带日期的是 10 个。
   */
  const seen = new Set();
  return out.filter((it) => {
    if (!it.publishedAt) return false;
    return seen.has(it.url) ? false : seen.add(it.url);
  });
}

/**
 * 详情页正文。只对站内 info/*.htm 抓 —— 外链（公众号、研究生院站点）结构各异，
 * 一是不值得为一个标题去解析 3MB 的公众号页面，二是那些页本来也不是全文的权威来源。
 */
function parseDetail(html) {
  // 去掉导航/页脚：正文通常在一个 content/xxgk 容器里，取「发布时间」之后的文本
  const main =
    (html.match(/<div[^>]*class="[^"]*(?:content|v_news_content|article)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*(?:footer|share))/i) || [])[1] ||
    html;
  const text = stripTags(main).slice(0, 6000);
  const dept = (html.match(/(?:来源|发布单位|供稿单位)[:：]\s*([^\n<]{2,30})/) || [])[1] || null;
  return { content: text, department: dept ? dept.trim() : null };
}

// ---------- 主流程 ----------

async function collectChannel(key) {
  const ch = CHANNELS[key];
  const items = new Map();

  for (let p = 0; p < PAGES; p++) {
    const url = p === 0 ? `${ch.base}.htm` : `${ch.base}/${p}.htm`;
    const r = await get(url);
    if (r.status !== 200) {
      console.log(`  ${ch.name} p${p}: HTTP ${r.status}，跳过`);
      continue;
    }
    const list = parseList(r.html, key);
    for (const it of list) if (!items.has(it.url)) items.set(it.url, it);
    console.log(`  ${ch.name} p${p}: 解析 ${list.length}，累计 ${items.size}`);
    if (list.length === 0) break;
    await sleep(DELAY);
  }

  return Array.from(items.values());
}

async function main() {
  const all = [];

  for (const key of CHANNELS_SEL) {
    console.log(`\n[${CHANNELS[key].name}]`);
    const items = await collectChannel(key);

    if (!NO_DETAIL) {
      const insite = items.filter((it) => it.url.startsWith(ORIGIN) && /\/info\//.test(it.url));
      let i = 0;
      for (const it of insite) {
        i++;
        process.stdout.write(`\r  详情 ${i}/${insite.length}`);
        try {
          const r = await get(it.url);
          if (r.status === 200) Object.assign(it, parseDetail(r.html));
        } catch {
          /* 单条失败不影响整批 */
        }
        await sleep(DELAY);
      }
      process.stdout.write("\n");
    }

    all.push(...items);
  }

  all.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

  if (DRY) {
    console.log(JSON.stringify(all.slice(0, 5), null, 2));
    console.log(`\n共 ${all.length} 条（--dry 不写文件）`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `notices-web-${stamp}.json`), JSON.stringify(all, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "notices-web-latest.json"), JSON.stringify(all, null, 2), "utf-8");

  const byDate = all.filter((x) => x.publishedAt).length;
  console.log(`\n完成：${all.length} 条，其中有日期 ${byDate} 条，带正文 ${all.filter((x) => x.content).length} 条`);
  console.log(`输出：${path.join(OUT_DIR, `notices-web-${stamp}.json`)}`);
}

main().catch((e) => {
  console.error("采集失败：", e.message);
  process.exit(1);
});
