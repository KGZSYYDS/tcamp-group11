import { RELATIVE_PHRASES, resolveRelative, shanghaiParts } from "../time";

/**
 * 证据校验：判断一个日期是否"真的有原文依据"。
 *
 * 这是抑制大模型编造日期的核心手段，规则很简单但很有效：
 * 1. 字面命中——把 ISO 反格式化成若干中文/数字写法，在原文里找得到 → 可信
 * 2. 相对解析——原文里有"下周三"这类词，且解析结果正好是这个日期 → 可信
 * 3. 两者都不成立 → 判为幻觉，调用方必须丢弃该日期
 */

export interface DateEvidence {
  ok: boolean;
  method: "literal" | "relative" | "none";
  /** 命中的原文片段，便于 UI 回原文定位 */
  snippet?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 去掉所有空白与全角空格，便于做子串匹配 */
export function compact(text: string): string {
  return (text || "").replace(/[\s\u3000]+/g, "");
}

function literalForms(iso: string): string[] {
  const p = shanghaiParts(iso);
  if (!p) return [];
  const { y, m, d } = p;
  return [
    `${y}-${pad2(m)}-${pad2(d)}`,
    `${y}年${m}月${d}日`,
    `${y}年${pad2(m)}月${pad2(d)}日`,
    `${m}月${d}日`,
    `${pad2(m)}月${pad2(d)}日`,
    `${m}月${d}号`,
    `${m}/${d}`,
    `${pad2(m)}/${pad2(d)}`,
    `${y}.${pad2(m)}.${pad2(d)}`,
  ];
}

export function verifyDateEvidence(iso: string, text: string, anchorIso: string): DateEvidence {
  const p = shanghaiParts(iso);
  if (!p) return { ok: false, method: "none" };

  const haystack = compact(text);
  if (!haystack) return { ok: false, method: "none" };

  for (const form of literalForms(iso)) {
    const at = haystack.indexOf(form);
    if (at !== -1) {
      const from = Math.max(0, at - 12);
      return {
        ok: true,
        method: "literal",
        snippet: haystack.slice(from, at + form.length + 12),
      };
    }
  }

  const dateIso = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  for (const phrase of RELATIVE_PHRASES) {
    if (!haystack.includes(phrase)) continue;
    const resolved = resolveRelative(phrase, anchorIso);
    if (!resolved) continue;
    if (resolved.iso.slice(0, 10) === dateIso) {
      const at = haystack.indexOf(phrase);
      return {
        ok: true,
        method: "relative",
        snippet: haystack.slice(Math.max(0, at - 12), at + phrase.length + 12),
      };
    }
  }

  return { ok: false, method: "none" };
}

/**
 * 标题可信度：标题里的字有多大比例能在正文中找到。
 * 用来识别"模型自己概括了一个标题"——契约要求标题不可改写。
 */
export function verifyTitle(title: string, text: string): { ok: boolean; ratio: number } {
  const chars = Array.from(compact(title)).filter((c) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(c));
  if (chars.length === 0) return { ok: false, ratio: 0 };
  const haystack = compact(text);
  const hit = chars.filter((c) => haystack.includes(c)).length;
  const ratio = hit / chars.length;
  return { ok: ratio >= 0.6, ratio };
}

/** 归属值（学院/班级名）必须原样出现在原文里，否则视为模型编造 */
export function verifyAudienceValue(value: string | undefined, text: string): boolean {
  const v = compact(value || "");
  if (!v) return false;
  return compact(text).includes(v);
}
