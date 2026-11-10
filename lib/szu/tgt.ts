/**
 * 用「用户自己浏览器里已有的登录票据」建立办事大厅会话。
 *
 * 为什么需要这条路：
 * 学校的统一认证会按**登录地点**做风控。服务端跑在上海机房，用户人在深圳，
 * 一次密码登录在 CAS 眼里就是「深圳的人，从上海登录」—— 会被插一层
 * reAuthCheck 二次认证（短信/扫码），机器永远过不去。这不是代码 bug，
 * 换任何外地服务器都一样。
 *
 * 但实测发现：CASTGC（TGT）本身**不绑 IP**。拿着在深圳签发的 TGT，
 * 从上海去换 ticket 是能换到的。于是做法就变成：
 *   1. 让用户在自己的浏览器里登录统一认证（同城，不触发风控）
 *   2. 用户把浏览器里的 CASTGC 交给服务端
 *   3. 服务端用它换 ehall ticket，建立会话
 *
 * 密码因此彻底不需要经过服务器 —— 比原来的方式更安全。
 *
 * CASTGC 本身的处理原则：只用一次，**不落盘**。落盘的是换来的 ehall 会话
 * （学校发的那份 cookie），它才是后续拉课表要用的东西。
 */
import { CAS_HOST, CookieJar, casSsoInto } from "./cas";
import { EHALL_SERVICE, JWKW_SERVICE, ehallAlive } from "./portal";

/** TGT 形如 TGT-1276076-xxxxx；只做宽松校验，避免把明显填错的东西发去学校 */
export function looksLikeTgt(v: string) {
  return /^TGT-[0-9A-Za-z._-]{8,200}$/.test(v.trim());
}

/**
 * 拿用户交回的 CASTGC 换一个可用的办事大厅会话。
 * 返回的 jar 里含 ehall 的会话 cookie；CASTGC 也还在（后续可换教务的票）。
 */
export async function loginWithTgt(castgc: string, trace?: string[]) {
  const jar = new CookieJar();
  jar.set(CAS_HOST, "CASTGC", castgc.trim());

  // 用 TGT 换 ehall 的 ticket，并把跳转跟完，让 ehall 种下自己的会话
  const landed = await casSsoInto(jar, EHALL_SERVICE, trace);
  if (!(await ehallAlive(jar, trace))) {
    throw new Error(
      landed
        ? "票据换到了，但办事大厅没有接受这个会话。可能是票据已过期或被用过，请重新登录一次再复制"
        : "这个登录票据已经失效（CAS 没有放行），请重新登录一次再复制"
    );
  }
  return jar;
}

/**
 * 顺手把教务的票也换掉。
 *
 * 课表要用教务给的「第 1 周锚点」，没有它整学期日期会错位，
 * collectTimetable 会直接中止。教务换票失败不影响登录本身，
 * 所以这一条单独返回、由调用方决定怎么提示。
 */
export async function ssoJwkw(jar: CookieJar, trace?: string[]) {
  try {
    const landed = await casSsoInto(jar, JWKW_SERVICE, trace);
    return Boolean(landed);
  } catch {
    return false;
  }
}
