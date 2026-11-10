/**
 * 内容指纹与标题相似度。
 *
 * 用双种子 FNV-1a 拼成 64 位十六进制，而不是 SHA-256：
 * 浏览器与 Node 都能同步计算，不必把整条管道改成异步。
 * 用途是去重而不是防篡改，这个强度足够。
 */

function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function contentFingerprint(text: string): string {
  const normalized = (text || "").replace(/[\s\u3000]+/g, "").toLowerCase();
  const high = fnv1a32(normalized, 0x811c9dc5);
  const low = fnv1a32(normalized, 0x9e3779b9);
  return (
    high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0")
  );
}

function normalizeForCompare(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, "");
}

export function trigrams(text: string): Set<string> {
  const s = normalizeForCompare(text);
  const out = new Set<string>();
  if (s.length === 0) return out;
  if (s.length < 3) {
    out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 标题相似度，0~1 */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return jaccard(trigrams(left), trigrams(right));
}
