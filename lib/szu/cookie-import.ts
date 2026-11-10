/**
 * 用「用户浏览器里已经登录好的会话 cookie」建立服务端会话。
 *
 * 为什么不再让服务端登录：学校统一认证按登录地点风控。服务器在上海机房、
 * 用户人在深圳，无论是用密码还是用浏览器签发的 TGT 去换票，CAS 都会把这次
 * 请求判成异地并插一层 reAuthCheck 多因子认证 —— 机器永远过不去。
 *
 * 而办事大厅 / 教务自己的会话 cookie 是登录完成之后才发的，服务端拿着它
 * 直接请求业务接口，就不再经过 CAS，也就不会被二次认证拦。
 *
 * 用户侧只需要：在自己浏览器里登录（同城，不触发风控），把两个域名请求头里的
 * Cookie 值复制过来。密码和票据都不需要给服务器。
 *
 * 说明：这份 cookie 等同于「已登录凭证」，所以同样只保存在服务端会话文件里，
 * 不回显、不进日志。
 */
import { CookieJar } from "./cas";

export const HOST_EHALL = "ehall.szu.edu.cn";
export const HOST_JWKW = "jwkw.szu.edu.cn";

/**
 * 从用户粘贴的内容里取出 Cookie 头的值。支持三种常见粘贴方式：
 *   1. 纯 cookie 串：        a=1; b=2
 *   2. 带前缀：             Cookie: a=1; b=2
 *   3. 右键「Copy as cURL」：... -H 'Cookie: a=1; b=2' ...
 */
export function extractCookieHeader(raw: string): string {
  const text = raw.trim();
  if (!text) return "";

  if (/curl/i.test(text) && /cookie/i.test(text)) {
    // -H 'Cookie: ...' / -H "Cookie: ..." / --cookie '...' / -b '...'
    const m =
      text.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i) ||
      text.match(/--cookie\s+['"]?([^'"\s]+)['"]?/i) ||
      text.match(/(?:^|\s)-b\s+['"]?([^'"\s]+)['"]?/i);
    if (m) return m[1].trim();
  }

  return text.replace(/^cookie:\s*/i, "").trim();
}

/** 把 cookie 串拆成键值对；非法片段直接丢掉 */
export function parseCookieString(raw: string): [string, string][] {
  const out = new Map<string, string>();
  for (const part of extractCookieHeader(raw).split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name || !/^[A-Za-z0-9_.$-]+$/.test(name)) continue;
    if (!value) continue;
    out.set(name, value);
  }
  return [...out];
}

/** 粗略判断粘贴的是不是一份会话 cookie（避免把别的东西当 cookie 收下） */
export function looksLikeCookies(raw: string, host: "ehall" | "jwkw") {
  const names = parseCookieString(raw).map(([n]) => n.toLowerCase());
  if (!names.length) return false;
  const common = ["jsessionid", "mod_auth_cas", "route", "insert_cookie", "emap_lang", "castgc"];
  if (names.some((n) => common.includes(n))) return true;
  // 教务常见的是 route + 一堆大写业务 cookie；只要有两个以上就认为像
  if (host === "jwkw") return names.length >= 2;
  return names.length >= 2;
}

/** 用两段 cookie 串拼出一个 jar；教务那段可以不给 */
export function jarFromCookies(ehallRaw: string, jwkwRaw: string): CookieJar {
  const jar = new CookieJar();
  for (const [name, value] of parseCookieString(ehallRaw)) jar.set(HOST_EHALL, name, value);
  if (jwkwRaw.trim()) {
    for (const [name, value] of parseCookieString(jwkwRaw)) jar.set(HOST_JWKW, name, value);
  }
  return jar;
}
