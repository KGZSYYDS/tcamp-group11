/**
 * 畅课（lms.szu.edu.cn）登录 —— 服务端直连，不依赖浏览器扩展。
 *
 * 2026-11-09 实测的登录链（三跳，跟旧文档里的「直连 authserver」不一样）：
 *   GET https://lms.szu.edu.cn/login
 *     → 302 identity.szu.edu.cn/.../protocol/cas/login?service=...
 *     → 303 identity.szu.edu.cn/.../broker/cas-client/login?session_code=...
 *     → 303 authserver.szu.edu.cn/authserver/login?service=<identity 的 broker 回调>
 *     → 200 统一身份认证登录页（AES 加密密码那套，和办事大厅同款）
 *
 * 关键点：**必须在同一个 cookie jar 里走完这三跳**。broker 那一步会把
 * session_code 绑到 identity 的会话 cookie 上，另起一个 jar 直接 POST
 * authserver 会拿不到回跳，或者回跳后 identity 认不出这次认证。
 *
 * 密码只在这一次登录里存在：本模块不接受「保存密码」，也不写盘。
 * 缓存的是 cookie（data/.lms-session.json，0600），失效才需要再登录一次。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const LMS = "https://lms.szu.edu.cn";
const DATA_DIR = path.resolve("data");
export const LMS_SESSION_FILE = path.join(DATA_DIR, ".lms-session.json");

// ---------- 密码加密（与 authserver 前端 encrypt.js 等价） ----------

const AES_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
const rand = (n: number) =>
  Array.from({ length: n }, () => AES_CHARS[Math.floor(Math.random() * AES_CHARS.length)]).join("");

function encryptPassword(password: string, salt: string) {
  if (!salt) return password;
  const key = Buffer.from(salt, "utf-8");
  const iv = Buffer.from(rand(16), "utf-8");
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([
    cipher.update(Buffer.from(rand(64) + password, "utf-8")),
    cipher.final(),
  ]).toString("base64");
}

// ---------- cookie jar（跨 identity / authserver / lms 三个域） ----------

type Dump = [string, [string, string][]][];

export class Jar {
  store = new Map<string, Map<string, string>>();

  absorb(res: Response, host: string) {
    const list =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean as unknown as (x: string | null) => boolean);
    for (const raw of list as string[]) {
      const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      if (i < 0) continue;
      let domain = host;
      for (const a of attrs) {
        const [k, v] = a.split("=");
        if (k && k.toLowerCase() === "domain" && v) domain = v.replace(/^\./, "").toLowerCase();
      }
      if (!this.store.has(domain)) this.store.set(domain, new Map());
      const jar = this.store.get(domain)!;
      const value = pair.slice(i + 1);
      if (value === "" && /max-age=0|1970/i.test(raw)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), value);
    }
  }

  headerFor(url: string) {
    const host = new URL(url).hostname.toLowerCase();
    const out: string[] = [];
    for (const [d, m] of this.store) {
      if (host === d || host.endsWith("." + d)) for (const [k, v] of m) out.push(`${k}=${v}`);
    }
    return out.join("; ");
  }

  /** 只导出 lms 域的 cookie —— 别把 identity 的会话一起存下来 */
  dumpLms() {
    const out: [string, string[]][] = [];
    for (const [d, m] of this.store) {
      if (d === "lms.szu.edu.cn") out.push([d, Array.from(m, ([k, v]) => `${k}=${v}`)]);
    }
    return out;
  }

  static fromLmsDump(dump: [string, string[]][]) {
    const jar = new Jar();
    for (const [d, pairs] of dump || []) {
      jar.store.set(d, new Map(pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)])));
    }
    return jar;
  }
}

async function go(jar: Jar, url: string, init: RequestInit = {}) {
  const host = new URL(url).hostname.toLowerCase();
  const cookie = jar.headerFor(url);
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      "User-Agent": UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  });
  jar.absorb(res, host);
  return res;
}

const pick = (html: string, re: RegExp) => html.match(re)?.[1] || null;

export interface LoginResult {
  ok: boolean;
  /** 学号/工号（从会话里读，读不到就是 null） */
  studentId: string | null;
  message?: string;
}

/**
 * 走完三跳登录，成功后把 lms 的 cookie 写进缓存。
 * 密码用完即弃，函数返回后不再有任何引用。
 */
export async function loginLms(username: string, password: string): Promise<LoginResult> {
  const jar = new Jar();

  // 1) 三跳：lms → identity cas → identity broker → authserver 登录页
  let url = `${LMS}/login`;
  let loginHtml = "";
  let service: string | null = null;

  for (let i = 0; i < 6; i++) {
    const res = await go(jar, url);
    const loc = res.headers.get("location");
    if (!loc) {
      loginHtml = await res.text();
      break;
    }
    const next = new URL(loc, url).toString();
    // authserver 的 service 参数就是 broker 的回调地址，登录 POST 时要带它
    if (next.includes("authserver.szu.edu.cn/authserver/login")) {
      service = new URL(next).searchParams.get("service");
    }
    url = next;
  }

  if (!service) {
    return { ok: false, studentId: null, message: "没能拿到统一认证的 service 参数，登录链可能变了" };
  }
  if (!/pwdEncryptSalt/.test(loginHtml)) {
    return { ok: false, studentId: null, message: "没拿到认证登录页（可能已是登录态，或页面结构变化）" };
  }

  const salt = pick(loginHtml, /id="pwdEncryptSalt"\s+value="([^"]*)"/) || "";
  const execution = pick(loginHtml, /name="execution"\s+value="([^"]*)"/) || "e1s1";
  const lt = pick(loginHtml, /name="lt"[^>]*value="([^"]*)"/) || "";

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

  const postUrl = `https://authserver.szu.edu.cn/authserver/login?service=${encodeURIComponent(service)}`;
  const post = await go(jar, postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: url,
      Origin: "https://authserver.szu.edu.cn",
    },
    body: body.toString(),
  });

  if (post.status === 401) {
    // 实测：账号密码错时认证服务器返回 401 + 带 showErrorTip 的登录页（不是 200）。
    // 早先按 200 判断，会把「密码错」错报成「被风控」，用户根本不知道该改什么。
    return { ok: false, studentId: null, message: "学号或密码不对（与办事大厅同一个密码）" };
  }
  if (post.status === 429) {
    return { ok: false, studentId: null, message: "试得太频繁，等几分钟再登" };
  }
  if (post.status === 200) {
    const fail = await post.text();
    if (/showErrorTip|pwdErrorTip|账号或密码|认证失败|invalid/i.test(fail)) {
      return { ok: false, studentId: null, message: "学号或密码不对（与办事大厅同一个密码）" };
    }
    return { ok: false, studentId: null, message: "登录没跳转，可能被风控拦了，过几分钟再试" };
  }

  // 2) 跟着回跳链走完：authserver → identity broker → lms，让 lms 种下自己的会话
  let current = new URL(post.headers.get("location") || "", postUrl).toString();
  for (let i = 0; i < 8; i++) {
    const res = await go(jar, current);
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      current = new URL(next, current).toString();
      continue;
    }
    break;
  }

  // 3) 用 /api/todos 验证会话真的可用（比看页面标题可靠）
  const probe = await go(jar, `${LMS}/api/todos`);
  const loggedIn = probe.status === 200 && (probe.headers.get("content-type") || "").includes("json");
  if (!loggedIn) {
    return {
      ok: false,
      studentId: null,
      message: "认证通过了，但畅课没建立会话。多半是账号还在审核或权限没开，换个时间再试",
    };
  }

  saveSession(jar.dumpLms());

  // 学号从 /api/user 读；这个接口对部分账号返回 403，那就退回用登录时的学号
  let studentId: string | null = null;
  try {
    const me = await go(jar, `${LMS}/api/user`);
    if (me.status === 200) {
      const j = await me.json();
      const v = j?.user_number || j?.username || j?.login_name;
      if (typeof v === "string") studentId = v;
    }
  } catch {
    // 这个接口不存在也没关系
  }
  if (!studentId && /^\d{6,}$/.test(username)) studentId = username;

  return { ok: true, studentId };
}

export function saveSession(dump: [string, string[]][]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LMS_SESSION_FILE, JSON.stringify(dump), "utf-8");
  try {
    fs.chmodSync(LMS_SESSION_FILE, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略
  }
}

export function loadSession(): Jar | null {
  try {
    const dump = JSON.parse(fs.readFileSync(LMS_SESSION_FILE, "utf-8")) as [string, string[]][];
    if (!Array.isArray(dump) || !dump.length) return null;
    return Jar.fromLmsDump(dump);
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    fs.unlinkSync(LMS_SESSION_FILE);
  } catch {
    // 本来就没有
  }
}

export function sessionAgeDays(): number | null {
  try {
    return (Date.now() - fs.statSync(LMS_SESSION_FILE).mtimeMs) / 86400_000;
  } catch {
    return null;
  }
}

// ---------- 数据接口 ----------

export interface LmsTodo {
  course: string;
  title: string;
  dueAt: string;
  url?: string;
  note?: string;
}

/**
 * 拼作业详情页链接。
 *
 * 实测（2026-11-09，真实账号）：`/course/{cid}/homework/{tid}` 是 404，
 * 只有 `/course/{cid}/learning-activity` 返回 200，SPA 的详情路由挂在 hash 上。
 * 所以用 `#/material/{id}` 这种形态；万一 id 对不上，最差也只是停在课程活动页，
 * 不会 404。
 */
function todoUrl(courseId: unknown, id: unknown): string | undefined {
  const cid = Number(courseId);
  const tid = Number(id);
  if (!Number.isFinite(cid) || !Number.isFinite(tid) || cid <= 0 || tid <= 0) return undefined;
  return `${LMS}/course/${cid}/learning-activity#/material/${tid}`;
}

/**
 * 拉全站待办。`GET /api/todos` 不用逐门课点开，一次拿到所有作业，
 * 这是畅课里最省事的一个接口（字段来自真实样本，见 extension/parser.js）。
 */
export async function fetchTodos(jar: Jar): Promise<{ todos: LmsTodo[]; expired: boolean }> {
  const res = await go(jar, `${LMS}/api/todos`);
  if (res.status === 302 || res.status === 401) return { todos: [], expired: true };
  if (!res.ok) throw new Error(`畅课待办接口返回 ${res.status}`);

  const j = await res.json();
  const list = Array.isArray(j?.todo_list) ? j.todo_list : [];

  // 课程名有时不在待办里，单独补一份映射
  const names = new Map<number, string>();
  try {
    const cr = await go(jar, `${LMS}/api/my-courses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (cr.ok) {
      const cj = await cr.json();
      for (const c of cj?.courses || []) if (c?.id && c?.name) names.set(Number(c.id), String(c.name));
    }
  } catch {
    // 拿不到课程名就用待办里自带的
  }

  const todos: LmsTodo[] = [];
  for (const t of list) {
    const title = typeof t?.title === "string" ? t.title.trim() : "";
    const raw = t?.end_time || t?.deadline;
    if (!title || !raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    const course =
      (typeof t.course_name === "string" && t.course_name) ||
      names.get(Number(t.course_id)) ||
      "未匹配课程";
    todos.push({
      course,
      title,
      dueAt: d.toISOString(),
      url: todoUrl(t.course_id, t.id),
      note: "畅课作业",
    });
  }

  // 同一门课同名作业可能重复出现（待办 + 课程活动），按课程+标题+截止去重
  const seen = new Set<string>();
  const uniq = todos.filter((t) => {
    const k = `${t.course}|${t.title}|${t.dueAt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { todos: uniq, expired: false };
}
