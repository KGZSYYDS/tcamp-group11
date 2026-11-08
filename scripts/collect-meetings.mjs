/**
 * 群聊 → 会议 采集器
 *
 * 链路：WeFlow 导出本机微信会话 → 拼成带时间的聊天记录 → 模型提取会议 → 去重 → 写云库
 *
 * 为什么能这么做：WeFlow 用用户自己的账号密钥读本机数据库，属于「导出自己的聊天记录」，
 * 不需要注入客户端、不读进程内存。密钥由 WeFlow 自己保管在本机配置目录，本脚本不读、不复制。
 *
 * 隐私边界（重要）：
 *   - 原始聊天只落在本机 data/wechat/ 下，**不上传**
 *   - 只有提取出来的会议事件（标题/时间/地点）进云库
 *   - 群里其他人的闲聊不落库；提取失败的片段也不落库
 *   - 送进模型的是文本，这一步无法避免，但只发消息正文、不发 wxid、不发头像/附件
 *
 * 归属：与课表同一套机制。source_url 带「学号哈希」，用户登录后在「我的」页认领一次，
 * 这些会议才归属到他账号并只对他可见。
 *
 * 用法：
 *   node scripts/collect-meetings.mjs --list                列出可选的群
 *   node scripts/collect-meetings.mjs --dry-run --days 7    只看提取结果，不写库
 *   node scripts/collect-meetings.mjs --groups "群名A,群名B" --days 3
 *   node scripts/collect-meetings.mjs                       按 data/meeting-sources.json 跑
 *   node scripts/collect-meetings.mjs --xh 2024150072       指定学号（默认从办事大厅会话取）
 */
import fs from "fs";
import path from "path";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { meetingSystemPrompt, weekAnchors } from "../lib/meeting-prompt.mjs";
import { ownerKeyOf, groupKeyOf } from "./lib/owner.mjs";
import {
  checkWeFlow,
  exportMessages,
  findWeFlow,
  listContacts,
} from "./lib/weflow.mjs";

// ---------- 配置 ----------

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";
const TABLE = `${ENDPOINT}/.cloud/database/rest/events`;
const HEADERS = { "x-webapp-access-key": KEY, "x-wb-webapp-access-key": KEY, "Content-Type": "application/json" };
const SOURCES_FILE = path.resolve("data/meeting-sources.json");
const OUT_DIR = path.resolve("data/meetings");
const RAW_DIR = path.resolve("data/wechat");

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: KEY,
});

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const LIST_ONLY = has("list");
const DRY = has("dry-run");
const NO_DB = has("no-db") || DRY;
const MEETINGS_ONLY = has("meetings-only");
const FORCE_XH = has("force-xh");
const DAYS = Number(opt("days", "7")) || 7;
const GROUPS_ARG = opt("groups");
const XH = opt("xh");
const MAX_CHUNK = 5000; // 单次送模型的字符上限，超过就切片

// ---------- 工具 ----------

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function log(...a) {
  console.log(...a);
}

/**
 * 给群名打分，判断它像不像「会发通知的群」。
 * 只用于 --list 排序提示，不影响实际采集：真正扫哪些群由 meeting-sources.json 决定。
 */
const GOOD_WORDS = [
  [4, ["通知", "禁言", "公告", "班群", "班级", "级群", "年级群", "课程群", "课群"]],
  [3, ["辅导员", "导生", "教务", "教学", "班委", "团支", "党支部", "社团", "战队", "项目组"]],
  [2, ["学院", "专业", "新生", "深大", "深圳大学", "大学", "课程", "考试", "讲座", "培训"]],
];
const BAD_WORDS = [
  "家教", "闲置", "二手", "福利", "粉丝", "会员", "尊享", "优惠", "折扣", "团购",
  "外卖", "奶茶", "糖水", "麦当劳", "奈雪", "拼车", "租房", "代购", "兼职", "招聘",
  "相亲", "交友", "游戏", "开黑", "水群", "吹水", "娱乐", "资源分享", "广告",
];

function scoreGroup(contact) {
  const name = contact.displayName || contact.username || "";
  let score = 0;
  const hits = [];
  for (const [w, words] of GOOD_WORDS) {
    for (const k of words) {
      if (name.includes(k)) {
        score += w;
        hits.push(k);
      }
    }
  }
  for (const k of BAD_WORDS) {
    if (name.includes(k)) {
      score -= 6;
      hits.push("-" + k);
    }
  }
  return { name, username: contact.username, score, hits };
}

/** 读取要扫的群：命令行 > 配置文件 > 空 */
function loadSources() {
  if (GROUPS_ARG) {
    return {
      groups: GROUPS_ARG.split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name })),
      options: {},
    };
  }
  if (fs.existsSync(SOURCES_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf-8"));
      const arr = Array.isArray(j) ? j : j.groups || [];
      const groups = arr
        .map((g) => (typeof g === "string" ? { name: g } : g))
        .filter((g) => g && (g.name || g.id));
      return { groups, options: j.options || {} };
    } catch (e) {
      throw new Error(`${SOURCES_FILE} 解析失败：${e.message}`);
    }
  }
  const example = SOURCES_FILE.replace(/\.json$/, ".example.json");
  throw new Error(
    `没有找到 ${path.relative(process.cwd(), SOURCES_FILE)}。\n` +
      (fs.existsSync(example)
        ? `把它复制成 data/meeting-sources.json 再改：cp "${path.relative(process.cwd(), example)}" "${path.relative(process.cwd(), SOURCES_FILE)}"`
        : "先用 `npm run meetings:list` 看有哪些群，再写这个文件或用 --groups 指定。")
  );
}

/**
 * 从本地已有的大厅 dump 里读真实学号，纯离线、毫秒级。
 *
 * 为什么不调 getEhallJar：那会走一遍完整登录（含重登），实测能把脚本卡住
 * 几分钟不返回。核对学号是顺手做的一道保险，不值得为它挂上登录流程。
 * 本地没有 dump 就跳过核对——真正的兜底是 10 位格式校验 + 用户自己确认。
 */
function studentIdFromLocalDump() {
  const files = [
    path.resolve("data/board/raw/userinfo.json"),
    path.resolve("data/tmp/user2.json"),
    path.resolve("data/tmp/user.json"),
  ];
  for (const f of files) {
    try {
      // 只认 "userId" 这个键。同页还有 `widget-08001511020018-01` 这类控件 id，
      // 随手用 \d{10} 扫全文会把它当成学号（踩过：整套会议归属哈希全错，
      // 用户拿真学号怎么认领都对不上，只能整批删了重采）。
      const m = fs.readFileSync(f, "utf-8").match(/"userId"\s*:\s*"(\d{6,20})"/);
      if (m) return m[1];
    } catch {
      // 没有这个文件就跳过
    }
  }
  return null;
}

/** 学号：命令行 > 本地缓存 > 本地 dump */
async function resolveStudentId() {
  if (XH) {
    const v = XH.trim();
    if (!/^\d{10}$/.test(v)) {
      throw new Error(`--xh "${v}" 不像学号（深大学号是 10 位纯数字），确认后重跑。`);
    }
    // 归错人的代价很高：source_url 里的哈希错了，用户拿真学号永远认领不到，
    // 只能整批删了重采。本地有大厅 dump 就顺手对一遍。
    const real = studentIdFromLocalDump();
    if (real && real !== v && !FORCE_XH) {
      throw new Error(
        `--xh ${v} 和本地登录信息里的学号 ${real} 不一致。\n` +
          `归属哈希写错会导致这批事件谁都无法认领。确认要用 ${v} 就加 --force-xh，否则改成 --xh ${real}。`
      );
    }
    return v;
  }
  const cached = path.resolve("data/.owner-xh");
  if (fs.existsSync(cached)) {
    const v = fs.readFileSync(cached, "utf-8").trim();
    if (/^\d{6,20}$/.test(v)) return v;
  }
  const fromDump = studentIdFromLocalDump();
  if (fromDump) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, fromDump, "utf-8");
    return fromDump;
  }
  return null;
}

/** 哪些消息类型带可读文字；图片/语音/表情只有路径，跳过 */
const TEXT_TYPES = new Set([
  "文本消息",
  "链接消息",
  "文件消息",
  "聊天记录",
  "小程序消息",
  "引用消息",
  "视频号消息",
  "位置消息",
  "名片消息",
]);

/** 把一批消息拼成 [时间] 发送者: 内容 的逐行记录 */
function toTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    if (!TEXT_TYPES.has(m.type)) continue;
    const content = String(m.content || "").replace(/\s+/g, " ").trim();
    if (!content || content === "[图片]") continue;
    const t = (m.formattedTime || "").slice(5, 16); // MM-DD HH:mm
    const who = m.senderDisplayName || (m.isSend ? "我" : "成员");
    lines.push(`[${t}] ${who}: ${content.slice(0, 400)}`);
  }
  return lines;
}

/** 按字符数切块，尽量在消息边界切开 */
function chunk(lines, size = MAX_CHUNK) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length > size && cur.length) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- 模型 ----------

async function pickModel() {
  const models = await cloud.llm.models.list();
  const m = models.find((x) => x && x.disabled !== true && x.enabled !== false);
  if (!m) throw new Error("没有可用的 AI 模型");
  return m;
}

async function extractFromChunk(model, text, groupName) {
  let answer = "";
  for await (const chunkRes of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: "system", content: meetingSystemPrompt(weekAnchors(), false) },
      { role: "user", content: `以下来自微信群「${groupName}」：\n\n${text}` },
    ],
    stream: true,
    response_format: { type: "json_object" },
  }) ) {
    const d = chunkRes.choices?.[0]?.delta?.content;
    if (d) answer += d;
  }
  const m = answer.match(/\[[\s\S]*\]/);
  if (!m) {
    const single = answer.match(/\{[\s\S]*\}/);
    if (!single) return [];
    try {
      return [JSON.parse(single[0])];
    } catch {
      return [];
    }
  }
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------- 归一化 ----------

function normalizeDate(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function hm(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const pad = (n) => String(n).padStart(2, "0");
  // 「24:00 前」= 当天结束，不是合法钟点，折成 23:59，
  // 否则拼出来的 2026-11-08T24:00 在 new Date 里是非法时间。
  if (h === 24 && mi === 0) return "23:59";
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}:${pad(mi)}`;
}

function shape(raw, groupName) {
  if (!raw || !raw.title) return null;
  const date = normalizeDate(raw.date);
  const startTime = hm(raw.startTime);
  const endTime = hm(raw.endTime);
  const remind = Number(raw.remindBefore);
  return {
    type: raw.type === "deadline" ? "deadline" : "meeting",
    title: String(raw.title).slice(0, 40),
    date,
    startTime,
    endTime,
    location: raw.location ? String(raw.location).slice(0, 80) : null,
    group: groupName,
    remindBefore: Number.isFinite(remind) && remind >= 0 && remind <= 2880 ? remind : 30,
    quote: raw.quote ? String(raw.quote).slice(0, 80) : null,
  };
}

/**
 * 内存内去重：同一条源消息、同一天、同一类，只留一条。
 * 跨群转发（不同群同一条通知）靠后面的 DB 层 source_url 判定，这里只管单次采集。
 */
function dedupe(list) {
  const seen = new Map();
  for (const m of list) {
    if (!m) continue;
    const k = `${m.msgKey || ""}|${m.date}|${m.type}`;
    if (!seen.has(k)) seen.set(k, m);
  }
  return [...seen.values()];
}

/**
 * 防幻觉 + 溯源：把每条结果挂回它来源的那条群消息。
 *
 * 为什么要挂消息 id：最初用「日期+时间+标题」当去重键，结果同一批消息连跑两次，
 * 模型把「提交体测督促情况反馈表」写成「填写体测督促情况反馈表」，去重键就对不上，
 * 每次同步都多插一批近似重复。模型给的标题本质是翻译，不稳定，不能当身份。
 * 改成「源消息 id + 日期」，同一句话重跑多少次都落在同一个键上。
 *
 * 顺带做 quote 校验：模型常用「…」掐头去尾，拆成片段逐段在原文里找。
 */
function attachSource(list, messages) {
  const norm = messages.map((m) => ({ m, text: normForMatch(m.content) }));
  for (const ev of list) {
    const parts = String(ev.quote || "")
      .split(/…+|\.{3,}|。。。+/)
      .map(normForMatch)
      .filter((p) => p.length >= 6);

    // 先要求所有片段都命中（最可信）；不行就退一步，用最长的那一段去认领，
    // 因为模型常把相邻两条消息合并成一条事件，原话必然只对得上一半。
    let hit = null;
    const find = (pred) => {
      for (let i = norm.length - 1; i >= 0; i--) if (pred(norm[i].text)) return norm[i].m;
      return null;
    };
    if (parts.length) {
      hit = find((t) => parts.every((p) => t.includes(p)));
      if (!hit) {
        const longest = [...parts].sort((a, b) => b.length - a.length)[0];
        hit = find((t) => t.includes(longest));
      }
    }

    // 认领不到源消息 = 无法去重。这里留 null，入库阶段会把它排除，
    // 而不是按日期编一个 id 硬塞进去——那样每跑一次就多一条重复。
    ev.quoteOk = hit ? parts.every((p) => normForMatch(hit.content).includes(p)) : null;
    ev.msgKey = hit ? String(hit.platformMessageId || hit.localId) : null;
  }
  return list;
}

function normForMatch(s) {
  return String(s || "")
    .replace(/&#x0?([0-9a-fA-F]{2,4});/g, (_, h) => String.fromCharCode(parseInt(h, h.length === 2 ? 16 : 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[\s\u3000，。、；：！？""''（）()【】\[\]『』…—\-·,.;:!?"']/g, "");
}

// ---------- 入库 ----------

function sourceUrlOf(ownerKey, m) {
  // 身份 = 学号哈希 / 群哈希 / 源消息 id / 日期。都跟模型措辞无关，重跑稳定。
  return `wechat://${ownerKey}/${groupKeyOf(m.group)}/${m.msgKey || "d" + m.date}/${m.date}`;
}

function toRow(ownerKey, m) {
  // 会议＝时间段；截止＝某个钟点之前，所以统一用「截止钟点」当 start_at，
  // 不写成 start~end（否则会出现 09:00~10:00 这种模型没给过的区间）。
  const cutoff = m.type === "deadline" ? m.endTime || m.startTime : m.startTime;
  const startAt = cutoff ? `${m.date}T${cutoff}:00+08:00` : `${m.date}T00:00:00+08:00`;
  const endAt = m.type !== "deadline" && m.startTime && m.endTime ? `${m.date}T${m.endTime}:00+08:00` : null;
  const note = [
    m.group ? `来自群：${m.group}` : "来自群聊",
    m.remindBefore > 0 ? `提醒:提前${m.remindBefore}分钟` : "提醒:关",
    m.quote ? `原话：${m.quote}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    kind: m.type === "deadline" ? "deadline" : "meeting",
    title: m.title,
    start_at: startAt,
    end_at: endAt,
    all_day: !cutoff,
    course: null,
    location: m.location,
    note,
    scope: "personal",
    source: "wechat",
    source_url: sourceUrlOf(ownerKey, m),
    link: null,
  };
}

async function existingKeys() {
  const keys = new Set();
  let offset = 0;
  const size = 1000;
  for (;;) {
    const res = await fetch(
      `${TABLE}?select=source_url&source=eq.wechat&limit=${size}&offset=${offset}`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`读取已有会议失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    for (const r of rows) if (r.source_url) keys.add(r.source_url);
    if (rows.length < size) break;
    offset += size;
  }
  return keys;
}

async function insert(rows, batch = 100) {
  let added = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunkRows = rows.slice(i, i + batch);
    const res = await fetch(TABLE, {
      method: "POST",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(chunkRows),
    });
    if (res.ok) added += chunkRows.length;
    else {
      failed += chunkRows.length;
      console.error(`\n  批次失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
    }
  }
  return { added, failed };
}

// ---------- 主流程 ----------

async function main() {
  const exe = findWeFlow();
  if (!exe) {
    throw new Error(
      "没找到 WeFlow。请安装后把路径写进环境变量 WEFLOW_EXE，或用 -- 见 docs/data-access.md §3.5"
    );
  }
  log(`WeFlow：${exe}`);

  const health = checkWeFlow(exe);
  log(`版本：${health.version}`);
  if (!health.connected) {
    throw new Error(
      "WeFlow 无法打开微信数据库。多半是密钥失效了：在微信里退出重登一次，再跑 `weflow key db --save --timeout 600`。"
    );
  }
  log(`数据库：已连接（${health.accountDir}）`);

  const contacts = listContacts(exe);
  const groups = contacts.filter((c) => c.type === "group");
  log(`会话：${contacts.length} 个，其中群 ${groups.length} 个`);

  if (LIST_ONLY) {
    const scored = groups.map((g) => scoreGroup(g)).sort((a, b) => b.score - a.score);
    const hits = has("all") ? scored : scored.filter((g) => g.score >= 3);
    log(`\n疑似通知群（${hits.length} 个 / 共 ${groups.length} 个群，按可能性排序）：`);
    if (!hits.length) log("  （没筛出来，加 --all 看全部群）");
    for (const g of hits.slice(0, has("all") ? 400 : 40)) {
      const tag = g.hits.length ? g.hits.join(" ") : "-";
      log(`  ${String(g.score).padStart(3)}  ${g.name}   ${g.username}   [${tag}]`);
    }
    log("\n分数越高越可能发通知。挑好后写进 data/meeting-sources.json，");
    log("或用 --groups \"群名A,群名B\" 指定；加 --all 可看全部群。");
    return;
  }

  const { groups: sources, options } = loadSources();
  if (!sources.length) {
    throw new Error("data/meeting-sources.json 里没有配置任何群。");
  }

  // 命令行没显式给 --days 时，用配置文件里的值
  const days = opt("days") ? DAYS : Number(options.days) > 0 ? Number(options.days) : DAYS;
  const withDeadline = MEETINGS_ONLY ? false : options.includeDeadline !== false;

  // 名字 → 会话 id
  const byName = new Map(groups.map((g) => [g.displayName, g]));
  const targets = [];
  for (const s of sources) {
    const g = s.id ? { username: s.id, displayName: s.name || s.id } : byName.get(s.name);
    if (!g) {
      console.warn(`  ⚠ 找不到群「${s.name}」，跳过（先用 npm run meetings:list 核对群名）`);
      continue;
    }
    targets.push(g);
  }
  if (!targets.length) throw new Error("指定的群一个都没找到");

  const xh = await resolveStudentId();
  if (!xh) {
    throw new Error(
      "拿不到学号，无法确定这些会议归谁。用 --xh <学号> 指定，或先跑一次 collect:timetable 让会话缓存下来。"
    );
  }
  const ownerKey = ownerKeyOf(xh);
  log(`归属键：${ownerKey}（学号哈希，用于认领）`);

  const today = new Date();
  const start = isoDate(addDays(today, -days));
  const end = isoDate(today);
  log(`时间范围：${start} ~ ${end}（${days} 天）`);
  log(`收录：${withDeadline ? "会议 + 截止时间" : "只看会议"}\n`);

  const model = await pickModel();
  log(`模型：${model.id}\n`);

  const all = [];
  for (const g of targets) {
    const dir = path.join(RAW_DIR, `${g.displayName}-${start}_${end}`.replace(/[\\/:*?"<>|]/g, "_"));
    process.stdout.write(`  导出 ${g.displayName} … `);
    let exp;
    try {
      exp = exportMessages(exe, g.username, dir, { start, end });
    } catch (e) {
      // 这个区间没消息是常态（静默群），不当成错误刷屏
      console.log(/no messages found/i.test(e.message) ? "本区间没消息" : `失败：${e.message}`);
      continue;
    }
    const lines = toTranscript(exp.messages);
    console.log(`${exp.count} 条消息，${lines.length} 条含文字`);

    if (!lines.length) continue;

    const chunks = chunk(lines);
    const got = [];
    for (const c of chunks) {
      try {
        got.push(...(await extractFromChunk(model, c.join("\n"), g.displayName)));
      } catch (e) {
        console.warn(`    切片解析失败：${e.message}`);
      }
    }
    const shaped = got.map((r) => shape(r, g.displayName)).filter(Boolean);
    const kept = withDeadline ? shaped : shaped.filter((m) => m.type !== "deadline");
    const ddl = kept.filter((m) => m.type === "deadline").length;
    attachSource(kept, exp.messages);
    console.log(`    → 提取 ${kept.length} 条（会议 ${kept.length - ddl}、截止 ${ddl}）`);
    all.push(...kept);
  }

  const merged = dedupe(all);
  // 只保留今天及以后；过去的事提醒没意义
  const future = merged.filter((m) => m.date && m.date >= isoDate(today));
  const dropped = merged.length - future.length;

  log(`\n合计：提取 ${all.length} 条 → 去重 ${merged.length} → 保留未来 ${future.length} 条（丢弃过去 ${dropped} 条）`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `meetings-${isoDate(today)}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), range: { start, end }, groups: targets.map((t) => t.displayName), meetings: future }, null, 2),
    "utf-8"
  );
  log(`已写入 ${path.relative(process.cwd(), outFile)}`);

  for (const m of future) {
    const tag = m.type === "deadline" ? "截止" : "会议";
    // deadline 是「某时刻之前」，不写成 start~end 时间段
    const when =
      m.type === "deadline"
        ? m.startTime || m.endTime || "全天"
        : `${m.startTime || "--:--"}${m.endTime ? "~" + m.endTime : ""}`;
    const warn = m.msgKey ? (m.quoteOk === false ? "  ⚠原话被改写" : "") : "  ⚠没认出来源消息";
    log(`  [${tag}] ${m.date} ${when}  ${m.title}${m.location ? "  @" + m.location : ""}  〔${m.group}〕${warn}`);
  }

  // 认不出来源消息的，没法保证重跑不重复，因此不入库，只在屏幕上交给人看。
  const anchorless = future.filter((m) => !m.msgKey);
  if (anchorless.length) {
    log(`\n其中 ${anchorless.length} 条没能对上群里的任何一条原消息（多半是模型把几条通知揉成一条并改了措辞）。`);
    log("这些不进库，避免每次同步都多出一份重复；确属要记，用网页「粘贴导入」手动加。");
  }

  if (DRY) {
    log("\n--dry-run：不写库");
    return;
  }
  if (NO_DB) return;

  const rows = future.filter((m) => m.msgKey).map((m) => toRow(ownerKey, m));
  if (!rows.length) {
    log("\n没有可入库的新条目。");
    return;
  }
  const exists = await existingKeys();
  const todo = rows.filter((r) => !exists.has(r.source_url));
  log(`\n库里已有 ${exists.size} 条来源为 wechat 的会议，本次新增 ${todo.length} 条`);
  if (!todo.length) return;

  const res = await insert(todo);
  log(`入库完成：新增 ${res.added}，失败 ${res.failed}`);
  log(`\n提醒：这些会议归属到学号哈希 ${ownerKey}，需要在网页「我的」页填学号认领一次，才会显示并只对你可见。`);
}

main().catch((e) => {
  console.error("\n失败：" + e.message);
  process.exit(1);
});
