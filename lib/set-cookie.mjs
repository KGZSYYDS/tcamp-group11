/**
 * Set-Cookie 拆条。
 *
 * 为什么需要手写：Node 的 fetch（undici）在 18.14 之后才有 Headers.getSetCookie()，
 * 更早的运行时、以及某些 fetch 包装层，只能拿到「一条用逗号拼接的字符串」。
 * 这时直接 `raw.split(";")` 只能解析出第一条 cookie，后面的全部静默丢失。
 *
 * 深大办事大厅在票据校验那一步一次要种 route / MOD_AUTH_CAS / asessionid / JSESSIONID，
 * 丢了 MOD_AUTH_CAS，表现就是「统一认证通过了，但 /jsonp/userInfo.json 里 hasLogin:false」。
 * 这个 bug 只在部分运行时出现，本机开发时看不出来，所以必须按最保守的方式解析。
 */

// cookie 名允许的字符集（RFC 6265 token），后面紧跟 "="
const COOKIE_PAIR = /^[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/;

/**
 * 把可能被合并成一条的 Set-Cookie 字面量拆成多条。
 *
 * 难点在于逗号既可能是 cookie 之间的分隔符，也可能是 Expires 里的日期分隔符：
 *   `a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT, b=2; Path=/`
 * 判据是「逗号后面跟着 空白 + name=」，而 `01 Jan ...` 不会命中。
 */
export function splitSetCookie(merged) {
  if (!merged) return [];

  const out = [];
  let buf = "";

  for (let i = 0; i < merged.length; i++) {
    const ch = merged[i];
    if (ch === "," && COOKIE_PAIR.test(merged.slice(i + 1))) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);

  return out.map((s) => s.trim()).filter(Boolean);
}
