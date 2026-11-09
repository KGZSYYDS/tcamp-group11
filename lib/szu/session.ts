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
 * 顺带把 CAS 的 cookie jar 也缓存到 data/ 下（cookie 不是密码，30 天自然过期，
 * 换设备无法使用）。好处是网页登录过之后，命令行采集也能直接复用会话，
 * 不用为了跑一次脚本再输一次密码——而反复登录正是 401 风控的触发条件。
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
const EHALL_FILE = path.join(DATA_DIR, ".ehall-session.json");
const JWKW_FILE = path.join(DATA_DIR, ".jwkw-session.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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

// ---------- CAS 会话缓存 ----------

function saveJar(file: string, jar: CookieJar) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(jar.dump()), { mode: 0o600 });
}

function loadJar(file: string) {
  if (!fs.existsSync(file)) return null;
  try {
    return new CookieJar().restore(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
}

export function saveEhallJar(jar: CookieJar) {
  saveJar(EHALL_FILE, jar);
}

export function loadEhallJar() {
  return loadJar(EHALL_FILE);
}

export function saveJwkwJar(jar: CookieJar) {
  saveJar(JWKW_FILE, jar);
}

export function loadJwkwJar() {
  return loadJar(JWKW_FILE);
}
