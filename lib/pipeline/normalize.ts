/**
 * 归一化层：把"人写的、机器给的、网页扒的"文本压成同一形态。
 * 纯函数，不依赖 cloud、不依赖 React，可在浏览器与服务端同构运行。
 */

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

/** HTML → 纯文本。老 ASP 页面用 <br>/<p>/&nbsp; 排版，这里一并处理。 */
export function htmlToText(html: string): string {
  if (!html) return "";
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "· ")
    .replace(/<[^>]+>/g, "");

  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
    safeChar(parseInt(hex, 16))
  );
  text = text.replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)));
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(char);
  }
  return text;
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * 全角转半角：只处理 ASCII 区间的全角字符与全角空格。
 * 中文标点（，。；）保持原样——它们是正文的一部分，转掉反而难读。
 */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, " ")
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "");
}

/** 空白归一：保留段落分隔，合并行内空格 */
export function normalizeSpace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 去掉常见的网页噪声：阅读数、责任编辑、上一篇下一篇 */
export function stripPageNoise(text: string): string {
  return text
    .replace(/^(阅读|浏览|点击)[:：]?\s*\d+\s*(次|人)?$/gm, "")
    .replace(/^责任编辑[:：].*$/gm, "")
    .replace(/^(上一篇|下一篇)[:：].*$/gm, "")
    .replace(/^【?(打印|关闭|返回|收藏)】?$/gm, "")
    .replace(/^\s*[-—=]{3,}\s*$/gm, "");
}

export function normalizeText(raw: {
  title?: string;
  content?: string;
}): { title: string; body: string } {
  const rawTitle = raw.title || "";
  const rawBody = raw.content || "";
  const title = normalizeSpace(toHalfWidth(htmlToText(rawTitle)));
  const bodyText = looksLikeHtml(rawBody) ? htmlToText(rawBody) : rawBody;
  const body = normalizeSpace(stripPageNoise(toHalfWidth(bodyText)));

  // 正文开头重复标题时去掉，避免标题在卡片里出现两次
  const deduped =
    title && body.startsWith(title) ? body.slice(title.length).trim() : body;

  return { title, body: deduped };
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^spm$/i,
  /^share_?token$/i,
  /^from$/i,
  /^isappinstalled$/i,
];

/**
 * URL 规范化：去锚点、去追踪参数、域名与协议小写、参数排序、去尾斜杠。
 * 这是去重的第一锚点，必须稳定——同一条通知两次采集要得到同一个字符串。
 */
export function canonicalUrl(raw: string): string {
  const input = (raw || "").trim();
  if (!input) return "";

  const withoutHash = input.split("#")[0];
  const withScheme = withoutHash.startsWith("//") ? `https:${withoutHash}` : withoutHash;

  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return withoutHash;

    const params = Array.from(url.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAMS.some((re) => re.test(key)))
      .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));

    const search = params.length
      ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}`
      : "";
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const host = url.host.toLowerCase();

    return `${url.protocol.toLowerCase()}//${host}${path}${search}`;
  } catch {
    // 不是合法 URL（可能是相对路径或残缺链接）：只做最小清理
    return withoutHash.trim();
  }
}
