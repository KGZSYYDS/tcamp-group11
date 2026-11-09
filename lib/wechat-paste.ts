/**
 * 微信「复制消息」→ 可解析文本
 *
 * 背景：微信**没有**任何官方途径把聊天记录导出成 .txt / .json。
 *   - 手机「聊天记录迁移与备份」只是搬到另一台设备，不产出文件；
 *   - 电脑微信的聊天库在 `文档\WeChat Files\wxid_xxx\Msg\`（新版 `xwechat_files`），
 *     里面是加密的 .db，改扩展名用记事本打开只有乱码；
 *   - 想拿到可读文件，只能靠第三方工具（本机用 WeFlow）导，门槛很高。
 *
 * 所以对普通用户最短的一条路是：在微信里选中消息 → 复制 → 粘贴进来。
 * 麻烦的是各端复制出来的格式并不统一，这里负责把常见几种归一到
 * `[YYYY-MM-DD HH:mm] 昵称: 内容`，再交给 lib/chat-extract 的规则去排时间。
 *
 * 覆盖的格式：
 *   A. 电脑微信多选复制（最常见）
 *        张三  2026-11-09 10:23
 *        明天下午三点在致理楼 319 开会
 *   B. 带日期分隔行
 *        ————— 2026年11月9日 —————
 *        张三 10:23
 *        明天下午三点开会
 *   C. 只有昵称和冒号
 *        张三：明天下午三点开会
 *   D. 只有一段话，没有昵称没有时间（直接粘一句通知）
 */

interface OutMsg {
  at: Date | null;
  sender: string;
  body: string[];
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function fmt(at: Date, sender: string, body: string) {
  const d = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const t = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `[${d} ${t}] ${sender || "群消息"}: ${body.replace(/\s*\n\s*/g, " ").trim()}`;
}

/** 日期分隔行：————— 2026年11月9日 —————  /  ——— 11月9日 ——— */
function parseDateDivider(line: string): { y?: number; m: number; d: number } | null {
  if (!/^[\s—\-=*_~·]{2,}/.test(line) && !/^\d{4}年/.test(line)) return null;
  const full = line.match(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
  if (full) return { y: +full[1], m: +full[2], d: +full[3] };
  const md = line.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md) return { m: +md[1], d: +md[2] };
  return null;
}

/**
 * 消息头：`昵称  2026-11-09 10:23` / `昵称 10:23` / `昵称 2026/11/9 上午10:23`
 * 昵称部分不允许含空格和冒号，避免把正文里的「下午 3 点」之类误认成发送者。
 */
const HEADER_WITH_DATE =
  /^([^\s:：]{1,24})\s+(?:(20\d{2})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?\s+|(\d{1,2})[-/](\d{1,2})\s+)?(上午|下午|早上|中午|晚上)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/;

/** `昵称：内容` 单行式 */
const NAME_COLON = /^([^\s:：]{1,24})\s*[:：]\s*(.+)$/;

/** `昵称  内容`（无冒号，但前缀是短名字）—— 仅在整段没有时间时兜底，风险较高，默认不用 */

export interface PasteParseResult {
  /** 归一后的文本，可直接喂给 readChatFile / extractFromChats */
  text: string;
  /** 识别出多少条消息（给用户反馈） */
  messages: number;
  /** 是否识别出了消息结构；false 表示按一整段裸文本处理 */
  structured: boolean;
}

export function normalizeWeChatPaste(raw: string, now = new Date()): PasteParseResult {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  const msgs: OutMsg[] = [];
  let cur: OutMsg | null = null;
  // 用对象持有锚点日期：TS 在循环里对 let 变量做流分析会把它收窄成 never
  const anchor: { d: { y: number; m: number; d: number } | null } = { d: null };
  let sawHeader = false;

  const push = () => {
    if (cur && cur.body.join("").trim()) msgs.push(cur);
    cur = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const div = parseDateDivider(line);
    if (div) {
      push();
      anchor.d = { y: div.y ?? (anchor.d?.y || now.getFullYear()), m: div.m, d: div.d };
      continue;
    }

    const h = line.match(HEADER_WITH_DATE);
    if (h) {
      push();
      sawHeader = true;
      const [, name, y, mo, d, mo2, d2, period, hh, mm] = h;
      let hour = +hh;
      if (period && /下午|晚上/.test(period) && hour < 12) hour += 12;
      if (period === "中午" && hour < 11) hour += 12;
      const datePart = y && mo && d
        ? { y: +y, m: +mo, d: +d }
        : mo2 && d2
        ? { y: anchor.d?.y || now.getFullYear(), m: +mo2, d: +d2 }
        : anchor.d || { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
      cur = {
        at: new Date(datePart.y, datePart.m - 1, datePart.d, hour % 24, +mm),
        sender: name,
        body: [],
      };
      continue;
    }

    // `昵称：内容` —— 但正文里也常出现「地点：致理楼」，所以要求昵称不带标点且长度短
    const c = line.match(NAME_COLON);
    if (c && !/[，。！？、；]/.test(c[1]) && c[1].length <= 16) {
      push();
      sawHeader = true;
      cur = {
        at: anchor.d ? new Date(anchor.d.y, anchor.d.m - 1, anchor.d.d) : null,
        sender: c[1],
        body: [c[2]],
      };
      continue;
    }

    // 普通正文行：接到当前消息后面；没有当前消息就先建一条匿名
    if (!cur) {
      cur = {
        at: anchor.d ? new Date(anchor.d.y, anchor.d.m - 1, anchor.d.d) : null,
        sender: "",
        body: [],
      };
    }
    cur.body.push(line);
  }
  push();

  const usable = msgs.filter((m) => m.body.join("").trim().length >= 2);
  if (!sawHeader || usable.length === 0) {
    // 没识别出结构：原样当一整段，靠 extractFromChats 的裸文本逻辑处理
    return { text: raw.trim(), messages: 0, structured: false };
  }

  const text = usable
    .map((m) => (m.at ? fmt(m.at, m.sender, m.body.join(" ")) : `${m.sender || "群消息"}: ${m.body.join(" ")}`))
    .join("\n");

  return { text, messages: usable.length, structured: true };
}
