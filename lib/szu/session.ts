/**
 * 网页登录态。
 *
 * 这里要解决的是「打开网页要不要先认证」——不是「你是谁」。所以不建用户表、
 * 不引第三方账号体系：验证完学校统一认证，签一个本机密钥的 token 放进 httpOnly
 * cookie 就够了。服务端不存会话表，重启不丢登录态。
 *
 * 为什么用无状态 token 而不是内存 Map：Next dev 每次热重载都会重新执行模块，
 * 内存里的会话一改代码就没了，体验很差。签名 token 只依赖一个落在 data/ 下的
 * 密钥文件，重启照旧有效。
 *
 * CAS 的 cookie jar 也必须缓存，否则每次拉课表都要再走一遍登录（重复登录正是
 * 401 风控的触发条件）。**但缓存必须按浏览器分桶**：以前存在
 * data/.ehall-session.json 这一个文件里，单机跑是「我这台电脑的缓存」，搬到公网
 * 就变成所有人共用一份，B 能拿 A 的会话去教务系统取课表。
 * 现在每个归属键一个目录：data/users/<owner>/ehall.json，互相看不见。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CookieJar } from "./cas";
import type { SzuProfile } from "./portal";

export const SESSION_COOKIE = "szu_session";
export const SESSION_DAYS = 7;

const DATA_DIR = path.resolve("data");
const KEY_FILE = path.join(DATA_DIR, ".web-session-key");
const USERS_DIR = path.join(DATA_DIR, "users");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 单个归属键的目录；不存在就建，权限 700 */
export function ownerDir(owner: string) {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw new Error("归属键格式不对");
  const dir = path.join(USERS_DIR, owner);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 清理过老的会话目录。
 *
 * 公网会被很多人访问，每人一份 jar 不能无限堆下去。超过 30 天没动过的目录直接删，
 * 反正里面的 cookie 早就自然过期了。只在写入时顺带看一眼，不额外起定时任务。
 */
function pruneOwners(maxAgeDays = 30, maxDirs = 800) {
  let entries: string[];
  try {
    entries = fs.readdirSync(USERS_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  const dirs: { name: string; at: number }[] = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(USERS_DIR, name));
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > maxAgeDays * 86400_000) {
        fs.rmSync(path.join(USERS_DIR, name), { recursive: true, force: true });
        continue;
      }
      dirs.push({ name, at: st.mtimeMs });
    } catch {
      /* 并发删除时可能刚好消失，忽略 */
    }
  }
  if (dirs.length <= maxDirs) return;
  dirs.sort((a, b) => a.at - b.at);
  for (const old of dirs.slice(0, dirs.length - maxDirs)) {
    fs.rmSync(path.join(USERS_DIR, old.name), { recursive: true, force: true });
  }
}

/** 签名密钥：首次用到时生成，权限 600。丢了就是所有人重新登录，不会泄露任何东西。 */
function secret() {
  if (!fs.existsSync(KEY_FILE)) {
    ensureDir();
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(KEY_FILE, "utf-8").trim();
}

export interface SessionPayload {
  sub: string;
  name: string;
  college: string;
  major: string;
  grade: string;
  level: string;
  iat: number;
  exp: number;
}

const b64 = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function sign(data: string) {
  return b64(crypto.createHmac("sha256", secret()).update(data).digest());
}

export function createSession(profile: SzuProfile) {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: profile.studentId,
    name: profile.name,
    college: profile.college,
    major: profile.major,
    grade: profile.grade,
    level: profile.level,
    iat: now,
    exp: now + SESSION_DAYS * 86400,
  };
  const body = b64(JSON.stringify(payload));
  return { token: `${body}.${sign(body)}`, payload };
}

export function readSession(token?: string | null): SessionPayload | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = sign(body);
  // 长度不同直接判否，避免 timingSafeEqual 抛异常
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const p = JSON.parse(unb64(body).toString("utf-8")) as SessionPayload;
    if (!p?.sub || !p?.exp) return null;
    if (p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------- CAS 会话缓存（按归属键分目录） ----------

function saveJar(owner: string, name: string, jar: CookieJar) {
  ensureDir();
  pruneOwners();
  const dir = ownerDir(owner);
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(jar.dump()), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本无效
  }
}

function loadJar(owner: string, name: string) {
  try {
    const file = path.join(USERS_DIR, owner, name);
    if (!fs.existsSync(file)) return null;
    return new CookieJar().restore(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
}

export function saveEhallJar(owner: string, jar: CookieJar) {
  saveJar(owner, "ehall.json", jar);
}

export function loadEhallJar(owner: string) {
  return loadJar(owner, "ehall.json");
}

export function saveJwkwJar(owner: string, jar: CookieJar) {
  saveJar(owner, "jwkw.json", jar);
}

export function loadJwkwJar(owner: string) {
  return loadJar(owner, "jwkw.json");
}

/** 退出登录：只删这个人自己的桶 */
export function clearOwnerSessions(owner: string) {
  try {
    fs.rmSync(path.join(USERS_DIR, owner), { recursive: true, force: true });
  } catch {
    // 本来就没有
  }
}
