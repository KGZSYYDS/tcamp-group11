/**
 * 二次认证的「半途会话」暂存。
 *
 * 用户在页面上输密码 → 服务端把 CAS 会话推进到「等验证码」这一步 →
 * 需要跨两个 HTTP 请求保持同一个 cookie 罐，否则提交验证码时 CAS 不认。
 *
 * 存在进程内存里，**不落盘**：里面是还没完成认证的 CAS 会话，属于敏感凭据，
 * 掉电丢掉只是让用户重新点一次登录，不会造成别的影响。
 */
import crypto from "node:crypto";
import type { CookieJar, ReAuthCtx } from "./cas";

type Pending = {
  owner: string;
  jar: CookieJar;
  ctx: ReAuthCtx;
  studentId: string;
  expires: number;
  lastSentAt: number;
  sending: boolean;
};

const TTL = 5 * 60 * 1000;
const MAX = 200;
// Route bundles and development reloads must share the same pending login.
const shared = globalThis as typeof globalThis & { szuPendingMfa?: Map<string, Pending> };
const store = shared.szuPendingMfa ??= new Map<string, Pending>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
  // 兜底：异常情况下别把内存撑爆，先丢最早进来的
  while (store.size > MAX) {
    const first = store.keys().next().value;
    if (!first) break;
    store.delete(first);
  }
}

export function putMfa(owner: string, jar: CookieJar, ctx: ReAuthCtx, studentId: string) {
  sweep();
  const token = crypto.randomBytes(24).toString("hex");
  store.set(token, { owner, jar, ctx, studentId, expires: Date.now() + TTL, lastSentAt: Date.now(), sending: false });
  return token;
}

export function getMfa(token: string, owner: string) {
  const item = store.get(token);
  if (!item) return null;
  if (item.expires < Date.now()) {
    store.delete(token);
    return null;
  }
  // 换一台设备/换一个浏览器不能接着用别人的半途会话
  if (item.owner !== owner) return null;
  return item;
}

export function dropMfa(token: string) {
  store.delete(token);
}
