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
  code:
    | "BAD_CREDENTIALS"
    | "NEED_CAPTCHA"
    | "RATE_LIMITED"
    | "REAUTH"
    | "MFA_BAD"
    | "UNKNOWN";
  constructor(code: CasError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "CasError";
  }
}

/**
 * 二次认证（多因子）的上下文。
 *
 * 什么时候会走到这里：服务端每次登录都是**全新会话**，在 CAS 眼里就是
 * 「非可信浏览器」，于是插一层多因子。这跟用户是不是在校园网毫无关系 ——
 * 触发条件是「这台设备/这个会话没被信任过」，不是「IP 是异地」。
 *
 * 以前这里直接报错让用户去浏览器里操作，等于把难题推给用户。
 * 实际上它只是一张表单：发一条短信、收一个 6 位码、提交，全部都能在服务端完成。
 * 用户唯一要做的就是看一眼手机、把 6 位数填进来。
 */
export type ReAuthCtx = {
  service: string;
  reAuthType: string;
  isMultifactor: string;
  reAuthUserId: string;
  uuid: string;
  mfaUuid: string;
  /** 用户友好的说明，例如「短信验证码」 */
  what: string;
};

/** 每种二次认证方式对应的「发码接口」参数值，取自学校 reAuth.js */
const CODE_TYPE_NAME: Record<string, string> = {
  "3": "reAuthDynamicCodeType", // 手机短信
  "4": "reAuthWChatDynamicCodeType", // 企业微信
  "5": "reAuthCpdailyDynamicCodeType", // 今日校园
  "11": "reAuthEmailDynamicCodeType", // 邮箱
  "12": "reAuthDingTalkDynamicCodeType", // 钉钉
  "13": "reAuthWeLinkDynamicCodeType", // WeLink
  "15": "reAuthWeChatServiceDynamicCodeType", // 微信服务号
};

const REAUTH_TYPE_LABEL: Record<string, string> = {
  "3": "短信验证码",
  "4": "企业微信验证码",
  "5": "今日校园验证码",
  "11": "邮箱验证码",
  "12": "钉钉验证码",
  "13": "WeLink 验证码",
  "15": "微信验证码",
};

export type LoginStep =
  | { kind: "ok"; jar: CookieJar; ticket: string | null; finalUrl: string }
  | { kind: "mfa"; jar: CookieJar; ctx: ReAuthCtx };

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

    /*
     * 下面几行是给「能不能在服务端把短信验证走完」用的结构侦察：
     * 只记字段名 / 类型 / 值的长度，不记任何值本身（uuid、手机号都在里面）。
     */
    const forms = Array.from(html.matchAll(/<form[^>]*>/gi)).map((m) => m[0].replace(/\s+/g, " "));
    const inputs = Array.from(html.matchAll(/<input[^>]*>/gi)).map((m) => {
      const tag = m[0];
      const id = pick(tag, /id="([^"]*)"/);
      const name = pick(tag, /name="([^"]*)"/);
      const type = pick(tag, /type="([^"]*)"/) || "text";
      const val = pick(tag, /value="([^"]*)"/);
      return `${id || "-"}/${name || "-"}:${type}${val ? `:len${val.length}` : ""}`;
    });
    const selects = Array.from(html.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)).map(
      (m) => `${m[1]}=[${Array.from(m[2].matchAll(/value="([^"]*)"/gi)).map((x) => x[1]).join("|")}]`
    );
    const endpoints = Array.from(
      new Set(
        Array.from(html.matchAll(/["']([^"']*\.(?:do|htl|json)[^"']*)["']/gi))
          .map((m) => m[1])
          .filter((u) => !u.startsWith("http") || u.includes("authserver"))
      )
    ).slice(0, 12);
    const buttons = Array.from(html.matchAll(/<(?:button|a)[^>]*>([\s\S]*?)<\/(?:button|a)>/gi))
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
      .filter((s) => s && s.length <= 20)
      .slice(0, 14);

    traceAdd(trace, `二次认证 form: ${forms.join(" || ") || "-"}`);
    traceAdd(trace, `二次认证 input: ${inputs.join(" , ") || "-"}`);
    if (selects.length) traceAdd(trace, `二次认证 select: ${selects.join(" , ")}`);
    traceAdd(trace, `二次认证 接口: ${endpoints.join(" , ") || "-"}`);
    traceAdd(trace, `二次认证 按钮: ${buttons.join(" | ") || "-"}`);

    // 「信任此设备」这类选项是 radio，值本身不敏感，可以直接记
    const radios = Array.from(html.matchAll(/<input[^>]*type="radio"[^>]*>/gi)).map((m) => {
      const tag = m[0];
      return `${pick(tag, /name="([^"]*)"/) || "-"}=${pick(tag, /value="([^"]*)"/) || "-"}`;
    });
    if (radios.length) traceAdd(trace, `二次认证 radio: ${radios.join(" , ")}`);

    const scripts = Array.from(new Set(Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/gi)).map((m) => m[1])));
    traceAdd(trace, `二次认证 script: ${scripts.join(" , ") || "-"}`);

    const paths = Array.from(
      new Set(Array.from(html.matchAll(/[\w./-]*reAuthCheck[\w./-]*/gi)).map((m) => m[0]))
    ).slice(0, 16);
    traceAdd(trace, `二次认证 路径: ${paths.join(" , ") || "-"}`);

    // 内联脚本里通常写着「验证码提交到哪个地址、带哪些参数」，截一小段看用法
    const inline = Array.from(
      html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)
    )
      .map((m) => m[1])
      .join("\n");
    const snips: string[] = [];
    for (const kw of ["reAuthCheck", "dynamicCode", "otpCode", "getCode"]) {
      const i = inline.indexOf(kw);
      if (i >= 0) snips.push(inline.slice(Math.max(0, i - 90), i + 150).replace(/\s+/g, " "));
      if (snips.length >= 2) break;
    }
    if (snips.length) traceAdd(trace, `二次认证 片段: ${snips.join(" ‖ ").slice(0, 420)}`);

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
export async function casLoginStep(
  username: string,
  password: string,
  service: string,
  trace?: Trace
): Promise<LoginStep> {
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
      "学校这次要求输入图形验证码，程序认不出图片里的字母数字。等 10 分钟再试一次就好"
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
   * 密码对了、CASTGC 也签发了，但 CAS 把浏览器送到了 reAuthCheck（多因子认证）。
   *
   * 注意判据要落在「跳去的是 reAuth」，而不是「有没有 ticket」：
   * 有些版本会先给 reAuth 再给 ticket，只看 ticket 会误判。
   */
  if (/reAuthCheck|reAuthLoginView/i.test(ticketUrl)) {
    const ctx = await readReAuthCtx(jar, ticketUrl, service, trace);
    return { kind: "mfa", jar, ctx };
  }

  const finalUrl = await follow(jar, ticketUrl, 12, trace);
  traceAdd(trace, `最终落地 ${shortUrl(finalUrl)}`);

  return { kind: "ok", jar, ticket, finalUrl };
}

/** 兼容旧调用：遇到多因子就直接报错（新代码应该用 casLoginStep 走验证码） */
export async function casLogin(username: string, password: string, service: string, trace?: Trace) {
  const step = await casLoginStep(username, password, service, trace);
  if (step.kind === "mfa") {
    throw new CasError(
      "REAUTH",
      `学校要求二次认证（${step.ctx.what}），这次登录需要输入手机收到的验证码`
    );
  }
  return { jar: step.jar, ticket: step.ticket, finalUrl: step.finalUrl };
}

/** 从二次认证页读出提交验证码所需的全部参数 */
async function readReAuthCtx(
  jar: CookieJar,
  url: string,
  fallbackService: string,
  trace?: Trace
): Promise<ReAuthCtx> {
  const r = await requestWith(jar, url, {}, trace);
  const html = await r.text();

  // 页面把参数放在内联脚本的 reAuthParams 里，是标准 JSON（斜杠会转义）
  let params: Record<string, unknown> = {};
  const m = html.match(/reAuthParams\s*=\s*(\{[\s\S]*?\})\s*;?\s*[\r\n]/);
  if (m) {
    try {
      params = JSON.parse(m[1]) as Record<string, unknown>;
    } catch {
      /* 解析不了就退化成从隐藏字段取，不影响主流程 */
    }
  }
  const str = (k: string) => (params[k] === undefined || params[k] === null ? "" : String(params[k]));

  const uuid =
    pick(html, /id="uuid"[^>]*value="([^"]*)"/) ||
    pick(html, /name="uuid"[^>]*value="([^"]*)"/) ||
    str("uuid");

  const ctx: ReAuthCtx = {
    service: str("service") || fallbackService,
    reAuthType: str("reAuthType") || "3",
    isMultifactor: str("isMultifactor") || "1",
    reAuthUserId: str("reAuthUserId"),
    uuid,
    mfaUuid: pick(html, /id="mfa_uuid"[^>]*value="([^"]*)"/) || "",
    what: REAUTH_TYPE_LABEL[str("reAuthType")] || "短信验证码",
  };

  traceAdd(
    trace,
    `二次认证 kind=${ctx.reAuthType}(${ctx.what}) 用户=${ctx.reAuthUserId ? "有" : "无"} ` +
      `uuid=${ctx.uuid ? "有" : "无"} 多因子=${ctx.isMultifactor}`
  );
  return ctx;
}

/**
 * 切换二次认证方式（例如从企业微信切到短信）。
 * 学校默认给的方式不一定人人都有 —— 手机短信最保险。
 */
export async function switchReAuthType(
  jar: CookieJar,
  ctx: ReAuthCtx,
  target: string,
  trace?: Trace
) {
  const url = `${CAS}/authserver/reAuthCheck/changeReAuthType.do`;
  const r = await requestWith(
    jar,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${CAS}/authserver/reAuthCheck/reAuthLoginView.do`,
        Origin: CAS,
      },
      body: new URLSearchParams({
        isMultifactor: ctx.isMultifactor,
        reAuthType: target,
        service: ctx.service,
      }).toString(),
    },
    trace
  );

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await r.text()) as Record<string, unknown>;
  } catch {
    /* 失败就按原方式继续 */
  }
  const payload = (data.data ?? {}) as Record<string, unknown>;
  const now = String(payload.reAuthType ?? "");
  const ok = r.ok && Number(data.code) === 1 && now === target;
  traceAdd(trace, `切换认证方式 → ${target} ${ok ? "成功" : "失败（沿用原方式）"} HTTP=${r.status} code=${Number.isFinite(Number(data.code)) ? Number(data.code) : "未知"}`);
  if (ok) {
    ctx.reAuthType = now;
    ctx.what = REAUTH_TYPE_LABEL[now] || ctx.what;
  }
  return ok;
}

/**
 * 让学校把验证码发到用户手机上。
 * 返回手机号掩码，用来告诉用户「发到 135****6343 了」。
 */
export async function sendReAuthCode(jar: CookieJar, ctx: ReAuthCtx, trace?: Trace) {
  const codeType = CODE_TYPE_NAME[ctx.reAuthType];
  if (!codeType || !ctx.reAuthUserId) {
    traceAdd(trace, "发验证码失败：认证渠道或用户标识缺失");
    return {
      ok: false,
      mobile: "",
      message: "学校返回的认证渠道或用户标识不完整，无法确认发码，请重新登录",
    };
  }
  const url = `${CAS}/authserver/dynamicCode/getDynamicCodeByReauth.do`;
  const body = new URLSearchParams({
    userName: ctx.reAuthUserId,
    authCodeTypeName: codeType,
  });

  const r = await requestWith(
    jar,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${CAS}/authserver/reAuthCheck/reAuthLoginView.do`,
        Origin: CAS,
      },
      body: body.toString(),
    },
    trace
  );

  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON 说明接口变了，下面按失败处理 */
  }

  const res = String(data.res ?? "");
  const ok = r.ok && res.trim().toLowerCase() === "success";
  const mobile = String(data.mobile ?? "");
  traceAdd(trace, `发验证码 ${ok ? "成功" : "失败"} res=${res || "-"} 手机=${mobile ? "有" : "-"}`);

  return {
    ok,
    mobile,
    message: String(data.returnMessage ?? "") || (ok ? "" : "验证码没能发出来，稍等一下再试"),
  };
}

/**
 * 提交验证码，成功后顺带把 service 的 ticket 换回来并落地。
 * 这一步走通，就等于「用户亲手完成了一次多因子认证」。
 */
export async function submitReAuthCode(
  jar: CookieJar,
  ctx: ReAuthCtx,
  code: string,
  trace?: Trace
) {
  const url = `${CAS}/authserver/reAuthCheck/reAuthSubmit.do`;
  const body = new URLSearchParams({
    service: ctx.service,
    reAuthType: ctx.reAuthType,
    isMultifactor: ctx.isMultifactor,
    password: "",
    dynamicCode: code,
    uuid: ctx.uuid,
    answer1: "",
    answer2: "",
    otpCode: "",
  });

  const r = await requestWith(
    jar,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${CAS}/authserver/reAuthCheck/reAuthLoginView.do`,
        Origin: CAS,
      },
      body: body.toString(),
    },
    trace
  );

  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CasError("UNKNOWN", "二次认证返回了无法识别的内容，请稍后重试");
  }

  const code_ = String(data.code ?? "");
  if (/reAuth_failed|reAuth_unauthorized/i.test(code_)) {
    throw new CasError("MFA_BAD", String(data.msg ?? "") || "验证码不对或已过期，请重新输入");
  }

  // 认证通过后 CAS 才会放 ticket，必须再走一次 login
  const loginUrl = `${CAS}/authserver/login?service=${encodeURIComponent(ctx.service)}`;
  const lr = await requestWith(jar, loginUrl, {}, trace);
  const location = lr.headers.get("location");
  if (!location) throw new CasError("UNKNOWN", "二次认证通过了，但学校没有返回跳转地址");

  const ticketUrl = new URL(location, CAS).toString();
  const ticket = new URL(ticketUrl).searchParams.get("ticket");
  traceAdd(trace, `二次认证后 ticket=${ticket ? "是" : "否"}`);

  const finalUrl = await follow(jar, ticketUrl, 12, trace);
  traceAdd(trace, `最终落地 ${shortUrl(finalUrl)}`);

  return { ticket, finalUrl, jar };
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
