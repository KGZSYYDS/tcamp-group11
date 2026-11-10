/**
 * 深大统一身份认证（Apereo CAS 定制版）—— 服务端版本
 *
 * 与 scripts/lib/cas.mjs 的区别：那边给命令行用，凭据来自环境变量 / 交互输入；
 * 这边只给 Next 的 route handler 用，凭据来自一次 POST 的请求体，用完即弃。
 *
 * 密码做了什么、没做什么：
 *   做：在内存里按 authserver 的 encrypt.js 规则做 AES-128-CBC 加密后提交
 *   不做：不写日志、不落盘、不进任何队列。函数返回后引用就没了。
 *
 * 一次登录要拿两个域的会话（办事大厅 + 教务），但**不能登两次** ——
 * 统一认证对短时间内的重复登录会直接返回 401，且不会提示是风控。
 * 所以第二个域走 CAS 单点登录：带着第一次拿到的 TGC 去要 ticket，不再传密码。
 */
import crypto from "node:crypto";
import { splitSetCookie } from "../set-cookie.mjs";

export const CAS_HOST = "authserver.szu.edu.cn";
const CAS = `https://${CAS_HOST}`;
const AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------- 诊断轨迹 ----------

/**
 * 登录链路的逐步记录。
 *
 * 只在失败时收集（成功时是空数组），不落盘、不进日志。
 * 每条只写「主机 + 路径 + 状态码 + 这一跳种了哪些 cookie 名」：
 *   - 不写 query —— ticket 就在 query 里
 *   - 不写 cookie 值 —— 那是凭据
 *   - 不写密码 —— 从来没进过这里
 *
 * 有了它，「认证通过但办事大厅不认」这种跨域会话问题才能靠一次失败定位到具体一跳，
 * 否则只能靠猜操作系统、Node 版本、LB 粘性这些看不见的东西。
 */
export type Trace = string[];

export function traceAdd(trace: Trace | undefined, line: string) {
  if (!trace) return;
  if (trace.length >= 40) return;
  trace.push(line);
}

/** 只保留 host + path，去掉 query/hash */
function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function randomString(n: number) {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += AES_CHARS.charAt(Math.floor(Math.random() * AES_CHARS.length));
  }
  return s;
}

/** 等价于 authserver 前端 encrypt.js 的 encryptPassword(password, salt) */
export function encryptPassword(password: string, salt: string) {
  if (!salt) return password;
  const key = Buffer.from(salt, "utf-8");
  const iv = Buffer.from(randomString(16), "utf-8");
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([
    cipher.update(Buffer.from(randomString(64) + password, "utf-8")),
    cipher.final(),
  ]).toString("base64");
}

// ---------- 极简 cookie jar（跨 authserver / ehall / jwkw 多个域） ----------

/**
 * 取一条响应里的全部 Set-Cookie。
 *
 * 先试 undici 的 getSetCookie()；拿不到就按合并字符串拆。
 *
 * 兜底这条路不能省：`getSetCookie` 是 Node 18.14 之后才有的，
 * 更早的运行时（以及某些 fetch 包装层）只能拿到一条逗号拼接的 set-cookie 头。
 * 这时只解析第一条，办事大厅的 MOD_AUTH_CAS 就丢了，
 * 表现是「统一认证通过了，但 userInfo.json 里 hasLogin:false」。
 * 本机 Node 22 + Next 14 实测两条路都能拿到 3 条，所以别赌运行环境。
 */
function readSetCookies(headers: Headers): string[] {
  const h = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      const list = h.getSetCookie();
      if (list && list.length) return list;
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return splitSetCookie(headers.get("set-cookie"));
}

export class CookieJar {
  private store = new Map<string, Map<string, string>>();

  /** 收下响应里的 cookie，返回「本次种下的 cookie 名」（供轨迹记录，不含值） */
  addFromResponse(res: Response, requestHost: string): string[] {
    const list = readSetCookies(res.headers);
    const touched: string[] = [];

    for (const raw of list) {
      const parts = raw.split(";").map((p) => p.trim());
      const [pair, ...attrs] = parts;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);

      let domain = requestHost;
      for (const a of attrs) {
        const [k, v] = a.split("=");
        if (k.toLowerCase() === "domain" && v) domain = v.replace(/^\./, "").toLowerCase();
      }

      if (!this.store.has(domain)) this.store.set(domain, new Map());
      const jar = this.store.get(domain)!;
      if (value === "" && /expires=Thu, 01 Jan 1970|max-age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
      touched.push(name);
    }
    return touched;
  }

  headerFor(url: string) {
    const host = new URL(url).hostname.toLowerCase();

    // 域名越长越具体，必须先发。否则 ehall 和 jwkw 各自种的 JSESSIONID
    // 会同时出现在 Cookie 头里，服务端取第一个，就可能拿到另一个系统的会话。
    const domains = Array.from(this.store.keys())
      .filter((d) => host === d || host.endsWith("." + d))
      .sort((a, b) => b.length - a.length);

    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of domains) {
      for (const [k, v] of this.store.get(d)!) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(`${k}=${v}`);
      }
    }
    return out.join("; ");
  }

  /**
   * 只保留指定域的 cookie，生成一个新 jar。
   *
   * 用途：第一次票据校验失败后，用「只带 TGC 的干净 jar」重试。
   * ehall 在失败那次可能已经种了一个游客 asessionid，带着它再验票据，
   * 有些 SP 会复用那个游客会话、直接忽略新票 —— 清掉才验得干脆。
   */
  subset(hosts: string[]): CookieJar {
    const next = new CookieJar();
    for (const h of hosts) {
      const jar = this.store.get(h);
      if (jar) next.store.set(h, new Map(jar));
    }
    return next;
  }

  /** 手动放入一个 cookie（用于接收用户在浏览器里登录后交回的 TGT） */
  set(host: string, name: string, value: string) {
    const d = host.toLowerCase();
    if (!this.store.has(d)) this.store.set(d, new Map());
    this.store.get(d)!.set(name, value);
  }

  /** 某个域下现在有哪些 cookie 名（诊断用，不含值） */
  namesFor(host: string): string[] {
    const jar = this.store.get(host);
    return jar ? Array.from(jar.keys()) : [];
  }

  dump(): [string, [string, string][]][] {
    return Array.from(this.store, ([d, jar]) => [d, Array.from(jar)] as [string, [string, string][]]);
  }

  restore(dump: unknown) {
    this.store = new Map();
    for (const [domain, pairs] of (dump as [string, [string, string][]][]) || []) {
      this.store.set(domain, new Map(pairs));
    }
    return this;
  }
}

export async function requestWith(
  jar: CookieJar,
  url: string,
  options: RequestInit = {},
  trace?: Trace
) {
  const host = new URL(url).hostname.toLowerCase();
  const cookie = jar.headerFor(url);
  const method = (options.method || "GET").toUpperCase();

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": UA,
        ...(cookie ? { Cookie: cookie } : {}),
        ...((options.headers as Record<string, string>) || {}),
      },
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e) {
    // 网络层失败和「会话没建起来」是两种完全不同的病，必须分开记
    traceAdd(trace, `${method} ${shortUrl(url)} 网络失败 ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  const added = jar.addFromResponse(res, host);
  const location = res.headers.get("location");
  traceAdd(
    trace,
    `${method} ${shortUrl(url)} ${res.status}` +
      (added.length ? ` +[${added.join(",")}]` : "") +
      (location ? ` → ${shortUrl(new URL(location, url).toString())}` : "")
  );
  return res;
}

function pick(html: string, re: RegExp) {
  const m = html.match(re);
  return m ? m[1] : null;
}

/** 把 302 链跟完，让目标站点种下自己的会话 cookie */
async function follow(jar: CookieJar, start: string, max = 12, trace?: Trace) {
  let current = start;
  let finalUrl = start;
  for (let i = 0; i < max; i++) {
    const r = await requestWith(jar, current, {}, trace);
    finalUrl = r.url || current;
    const next = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && next) {
      current = new URL(next, current).toString();
      continue;
    }
    break;
  }
  return finalUrl;
}

export class CasError extends Error {
  code: "BAD_CREDENTIALS" | "NEED_CAPTCHA" | "RATE_LIMITED" | "REAUTH" | "UNKNOWN";
  constructor(code: CasError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "CasError";
  }
}

/**
 * 打开二次认证页，判断它要求的是哪种验证。
 * 只取「标题 + 表单字段 + 可见文案关键词」，不落 HTML、不外传。
 */
async function describeReAuth(jar: CookieJar, url: string, trace?: Trace) {
  try {
    const r = await requestWith(jar, url, {}, trace);
    const html = await r.text();

    const title = pick(html, /<title>([^<]*)<\/title>/i) || "";
    const fields = Array.from(
      new Set(
        Array.from(html.matchAll(/<(?:input|select|textarea)[^>]*name="([^"]+)"/gi)).map((m) => m[1])
      )
    );
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const hints: string[] = [];
    if (/短信|动态码|验证码/.test(text)) hints.push("需要短信验证码");
    if (/微信|企业微信/.test(text)) hints.push("可用微信验证");
    if (/人脸|刷脸/.test(text)) hints.push("需要人脸识别");
    if (/信任|记住.*设备/.test(text)) hints.push("有「信任此设备」选项");

    traceAdd(trace, `二次认证页 ${r.status} title=${title || "-"} fields=[${fields.join(",")}]`);
    traceAdd(trace, `二次认证提示：${hints.join(" / ") || "未识别"}；正文 ${text.slice(0, 120)}`);

    return { what: hints[0] || "", fields, title, status: r.status };
  } catch (e) {
    traceAdd(trace, `二次认证页打不开 ${e instanceof Error ? e.message : String(e)}`);
    return { what: "", fields: [] as string[], title: "", status: 0 };
  }
}

/**
 * 用学号 + 密码登录 CAS，并落到 service 指定的系统。
 * 返回的 jar 里同时含 authserver 的 TGC —— 后续可用 casSsoInto 换别的系统，不必再输密码。
 */
export async function casLogin(
  username: string,
  password: string,
  service: string,
  trace?: Trace
) {
  const jar = new CookieJar();
  const loginUrl = `${CAS}/authserver/login?service=${encodeURIComponent(service)}`;
  traceAdd(trace, `service=${service}`);

  const page = await requestWith(jar, loginUrl, {}, trace);
  const html = await page.text();

  const salt = pick(html, /id="pwdEncryptSalt"\s+value="([^"]*)"/);
  const execution =
    pick(html, /id="execution"\s+name="execution"\s+value="([^"]*)"/) ||
    pick(html, /name="execution"\s+value="([^"]*)"/) ||
    "e1s1";
  const lt = pick(html, /name="lt"\s+id="lt"\s+value="([^"]*)"/) || "";

  traceAdd(trace, `登录页 长度=${html.length} salt=${salt ? "有" : "无"} lt=${lt ? "有" : "无"}`);

  if (!salt) {
    throw new CasError("UNKNOWN", "登录页没有返回 pwdEncryptSalt，学校页面结构可能改了");
  }

  // 失败次数多的账号会被要求图形验证码，脚本过不去，只能提示用户去浏览器登录一次
  const capRes = await requestWith(
    jar,
    `${CAS}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}&_=${Date.now()}`,
    {},
    trace
  );
  let needCaptcha = false;
  try {
    needCaptcha = JSON.parse(await capRes.text()).isNeed === true;
  } catch {
    /* 接口异常按不需要处理 */
  }
  traceAdd(trace, `图形验证码=${needCaptcha ? "需要" : "不需要"}`);
  if (needCaptcha) {
    throw new CasError(
      "NEED_CAPTCHA",
      "这个账号需要图形验证码。先用自己的浏览器登录一次 authserver.szu.edu.cn，输入验证码后再回来"
    );
  }

  const body = new URLSearchParams({
    username,
    password: encryptPassword(password, salt),
    lt,
    execution,
    _eventId: "submit",
    cllt: "userNameLogin",
    dllt: "generalLogin",
    rmShown: "1",
  });

  // POST 目标必须带 service。表单 action 里没有，直接 POST /authserver/login 会 500。
  const post = await requestWith(jar, loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: loginUrl,
      Origin: CAS,
    },
    body: body.toString(),
  }, trace);

  if (post.status === 200) {
    const failHtml = await post.text();
    if (/id="pwdErrorTip"|账号或密码|认证失败|登录失败/i.test(failHtml)) {
      throw new CasError("BAD_CREDENTIALS", "学号或密码不对");
    }
    throw new CasError("RATE_LIMITED", "统一认证没有放行这次登录，稍等 30 分钟再试");
  }
  if (post.status === 401) {
    throw new CasError("RATE_LIMITED", "统一认证返回 401（短时间内重复登录触发风控），等 30–60 分钟再试");
  }

  const location = post.headers.get("location");
  if (!location) throw new CasError("UNKNOWN", `登录响应 ${post.status} 但没有跳转地址`);

  const ticketUrl = new URL(location, CAS).toString();
  const ticket = new URL(ticketUrl).searchParams.get("ticket");
  traceAdd(trace, `拿到 ticket=${ticket ? "是" : "否"}`);

  /**
   * 密码对了、CASTGC 也签发了，但 CAS 把浏览器送到了 reAuthCheck（二次认证）。
   *
   * 深大 CAS 在「登录地点/环境变化」时会插这一层：此时不发 ticket，
   * 必须先完成人机确认（短信、微信、或点确认）才放行。
   * 机器账号无法完成，所以不能当成普通失败 —— 要明确告诉用户去浏览器过一次。
   *
   * 注意判据要落在「跳去的是 reAuth」，而不是「有没有 ticket」：
   * 有些版本会先给 reAuth 再给 ticket，只看 ticket 会误判。
   */
  if (/reAuthCheck|reAuthLoginView/i.test(ticketUrl)) {
    const detail = await describeReAuth(jar, ticketUrl, trace);
    throw new CasError(
      "REAUTH",
      `学校判定这次登录是「新地点 / 异常环境」，要求二次认证${detail.what ? `（${detail.what}）` : ""}。` +
        `请用浏览器打开 authserver.szu.edu.cn 登录一次并完成验证，再回来重试`
    );
  }

  const finalUrl = await follow(jar, ticketUrl, 12, trace);
  traceAdd(trace, `最终落地 ${shortUrl(finalUrl)}`);

  return { jar, ticket, finalUrl };
}

/**
 * 已登录（jar 里有 TGC）时，为另一个系统换 ticket。
 * 走的是 CAS 单点登录，不传密码，因此不会触发重复登录风控。
 */
export async function casSsoInto(jar: CookieJar, service: string, trace?: Trace) {
  const url = `${CAS}/authserver/login?service=${encodeURIComponent(service)}`;
  traceAdd(trace, `SSO 换票 service=${service}`);
  const r = await requestWith(jar, url, {}, trace);
  const location = r.headers.get("location");

  // 没拿到 302 说明 TGC 没生效（过期或被拒），交给调用方决定是否重登
  if (r.status >= 300 && r.status < 400 && location) {
    return follow(jar, new URL(location, CAS).toString(), 12, trace);
  }
  if (r.status === 200) return null;

  const next = r.headers.get("location");
  return next ? follow(jar, new URL(next, CAS).toString()) : null;
}
