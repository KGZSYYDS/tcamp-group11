/**
 * 每台浏览器的归属键。
 *
 * 公网部署时，服务端要替**多个不同的人**缓存学校系统的 cookie（办事大厅、教务、
 * 畅课）。这些 cookie 一旦落在同一个文件里，B 打开页面就会读到 A 的课表 ——
 * 也就是串号。所以存储必须按人分桶，而分桶需要一个「这台浏览器是谁」的稳定标识。
 *
 * 这里不建用户表：登录本身已经签了 token（含学号），但**没登录也能用畅课**，
 * 那时没有学号可用。所以统一用一枚随机 httpOnly cookie 当归属键，登录前后都不变，
 * 清 cookie 等于换了个新桶（代价是重新登录一次学校系统，符合直觉）。
 *
 * 键只用于拼目录名，不含任何个人信息；目录名是 32 位随机十六进制，
 * 拿到它也推不出是谁。
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";

export const OWNER_COOKIE = "szu_owner";
const OWNER_TTL = 30 * 86400;
const OWNER_RE = /^[a-f0-9]{32}$/;

/**
 * 取（或发）当前请求的归属键。
 * 只能在 Route Handler 里调用——那里 cookies() 才可写。
 */
export function ownerKey(): string {
  const store = cookies();
  const existing = store.get(OWNER_COOKIE)?.value || "";
  if (OWNER_RE.test(existing)) return existing;

  const next = crypto.randomBytes(16).toString("hex");
  try {
    store.set(OWNER_COOKIE, next, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: OWNER_TTL,
    });
  } catch {
    // 写不了 cookie 的上下文（理论上不会走到）——本次请求仍可用，只是下次会重建
  }
  return next;
}

/** 只读版：没有就返回 null，不创建。给 GET 状态查询用，避免无谓地种 cookie。 */
export function peekOwnerKey(): string | null {
  const existing = cookies().get(OWNER_COOKIE)?.value || "";
  return OWNER_RE.test(existing) ? existing : null;
}
