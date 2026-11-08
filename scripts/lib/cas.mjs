/**
 * 深大统一身份认证（Apereo CAS 定制版）登录
 *
 * 密码在浏览器端做 AES-128-CBC 加密后再提交：
 *   明文 = randomString(64) + 密码
 *   key  = 页面隐藏域 pwdEncryptSalt（16 字符）
 *   iv   = randomString(16)
 * 字符集与 constants 与 authserver 的 encrypt.js 保持一致。
 *
 * 凭据只从本地文件 / 环境变量读取，不写进代码，不进仓库。
 */

import crypto from "crypto";

const CAS = "https://authserver.szu.edu.cn";
const AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

function randomString(n) {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += AES_CHARS.charAt(Math.floor(Math.random() * AES_CHARS.length));
  }
  return s;
}

/** 等价于 encrypt.js 的 encryptPassword(password, salt) */
export function encryptPassword(password, salt) {
  if (!salt) return password;
  const key = Buffer.from(salt, "utf-8");
  const iv = Buffer.from(randomString(16), "utf-8");
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([
    cipher.update(Buffer.from(randomString(64) + password, "utf-8")),
    cipher.final(),
  ]).toString("base64");
}

// ---------- 极简 cookie jar（跨 authserver / www1 两个域） ----------

export class CookieJar {
  constructor() {
    this.store = new Map(); // domain -> Map(name -> value)
  }

  addFromResponse(res, requestHost) {
    const list =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);

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
      const jar = this.store.get(domain);
      // 服务端删除 cookie 时 value 为空的常见写法
      if (value === "" && /expires=Thu, 01 Jan 1970|max-age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  headerFor(url) {
    const host = new URL(url).hostname.toLowerCase();
    const out = [];
    for (const [domain, jar] of this.store) {
      if (host === domain || host.endsWith("." + domain)) {
        for (const [k, v] of jar) out.push(`${k}=${v}`);
      }
    }
    return out.join("; ");
  }

  /** 供采集器直接使用 */
  toString() {
    const out = [];
    for (const jar of this.store.values()) {
      for (const [k, v] of jar) out.push(`${k}=${v}`);
    }
    return out.join("; ");
  }

  dump() {
    return Array.from(this.store, ([d, jar]) => [d, Array.from(jar)]);
  }

  /** 从 dump() 的形态恢复（用于把登录态缓存到磁盘，避免反复登录触发风控） */
  restore(dump) {
    this.store = new Map();
    for (const [domain, pairs] of dump || []) this.store.set(domain, new Map(pairs));
    return this;
  }
}

async function request(jar, url, options = {}) {
  const host = new URL(url).hostname.toLowerCase();
  const cookie = jar.headerFor(url);
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
    redirect: "manual",
  });
  jar.addFromResponse(res, host);
  return res;
}

function pick(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * 登录并返回 { cookie, jar, ticket, finalUrl }
 * service 形如 http://www1.szu.edu.cn/manage/caslogin.asp?rurl=%2Fboard%2F
 */
export async function casLogin(username, password, service) {
  const jar = new CookieJar();
  const loginUrl = `${CAS}/authserver/login?service=${encodeURIComponent(service)}`;

  const page = await request(jar, loginUrl);
  const html = await page.text();

  if (!/authserver\/login/.test(page.url) && page.status !== 200) {
    throw new Error(`登录页返回 ${page.status}`);
  }

  const salt = pick(html, /id="pwdEncryptSalt"\s+value="([^"]*)"/);
  const execution = pick(html, /id="execution"\s+name="execution"\s+value="([^"]*)"/)
    || pick(html, /name="execution"\s+value="([^"]*)"/)
    || "e1s1";
  const lt = pick(html, /name="lt"\s+id="lt"\s+value="([^"]*)"/) || "";

  if (!salt) throw new Error("登录页未返回 pwdEncryptSalt，页面结构可能已变");

  // 验证码按账号判定，失败次数多才需要
  const capRes = await request(
    jar,
    `${CAS}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(username)}&_=${Date.now()}`
  );
  let needCaptcha = false;
  try {
    needCaptcha = JSON.parse(await capRes.text()).isNeed === true;
  } catch {
    /* 接口异常按不需要处理 */
  }
  if (needCaptcha) {
    const err = new Error("该账号当前需要图形验证码，脚本无法自动通过");
    err.code = "NEED_CAPTCHA";
    throw err;
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

  // 关键：POST 目标必须带 service 查询串。
  // 表单 action 里没有 service（服务端从 session 取），但直接 POST /authserver/login
  // 会返回 500「哎呦，出错啦」—— 实测只有带 service 才返回 302 + ticket。
  const postUrl = `${CAS}/authserver/login?service=${encodeURIComponent(service)}`;
  const post = await request(jar, postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: loginUrl,
      Origin: CAS,
    },
    body: body.toString(),
  });

  // 失败时 CAS 会 200 重渲染登录页，并带错误提示
  if (post.status === 200) {
    const failHtml = await post.text();
    if (/id="pwdErrorTip"|账号或密码|认证失败|invalid|登录失败/i.test(failHtml)) {
      throw new Error("账号或密码错误（CAS 拒绝了这次登录）");
    }
    throw new Error("登录未跳转，可能被风控或页面结构变化");
  }

  const location = post.headers.get("location");
  if (!location) throw new Error(`登录响应 ${post.status} 但没有 Location`);

  const ticketUrl = new URL(location, CAS).toString();
  const ticket = new URL(ticketUrl).searchParams.get("ticket");

  // 跟完整条重定向链，让各站点种下自己的会话 cookie
  let current = ticketUrl;
  let finalUrl = ticketUrl;
  for (let i = 0; i < 6; i++) {
    const r = await request(jar, current);
    finalUrl = r.url || current;
    const next = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && next) {
      current = new URL(next, current).toString();
      continue;
    }
    break;
  }

  return { cookie: jar.toString(), jar, ticket, finalUrl };
}
