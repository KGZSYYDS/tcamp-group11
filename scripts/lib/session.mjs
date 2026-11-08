/**
 * 凭据与 Cookie 落盘（均在 data/ 下，已被 .gitignore 忽略）
 */
import fs from "fs";
import path from "path";

export const DATA_DIR = path.resolve("data");
export const CRED_FILE = path.join(DATA_DIR, ".credentials.json");
export const COOKIE_FILE = path.join(DATA_DIR, ".cookie.txt");

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function saveCredentials(username, password) {
  ensureDataDir();
  fs.writeFileSync(CRED_FILE, JSON.stringify({ username, password }, null, 2), "utf-8");
  // 尽量收紧权限（Windows 上基本无效，Linux/macOS 生效）
  try {
    fs.chmodSync(CRED_FILE, 0o600);
  } catch {}
}

export function loadCredentials() {
  if (process.env.SZU_USER && process.env.SZU_PASS) {
    return { username: process.env.SZU_USER, password: process.env.SZU_PASS };
  }
  if (fs.existsSync(CRED_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
      if (raw.username && raw.password) return raw;
    } catch {}
  }
  return null;
}

export function saveCookie(cookie) {
  ensureDataDir();
  fs.writeFileSync(COOKIE_FILE, cookie, "utf-8");
  try {
    fs.chmodSync(COOKIE_FILE, 0o600);
  } catch {}
}

export function loadCookie() {
  if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, "utf-8").trim();
  return "";
}

export function cookieAgeHours() {
  if (!fs.existsSync(COOKIE_FILE)) return Infinity;
  return (Date.now() - fs.statSync(COOKIE_FILE).mtimeMs) / 3600000;
}

// ---------- 办事大厅（ehall）会话缓存 ----------
// 统一认证对短时间内的重复登录会返回 401，所以把整条 cookie（按域保存）
// 落盘复用，只在失效时才重新登录。

export const EHALL_SESSION_FILE = path.join(DATA_DIR, ".ehall-session.json");

export function saveEhallSession(jar) {
  ensureDataDir();
  fs.writeFileSync(EHALL_SESSION_FILE, JSON.stringify(jar.dump()), "utf-8");
  try {
    fs.chmodSync(EHALL_SESSION_FILE, 0o600);
  } catch {}
}

export function loadEhallSessionDump() {
  if (!fs.existsSync(EHALL_SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(EHALL_SESSION_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ---------- 通用站点会话缓存 ----------
// 统一认证对短时间重复登录会 401，每个站点各存一份。

export const JWKW_SESSION_FILE = path.join(DATA_DIR, ".jwkw-session.json");

export function saveSessionFile(file, jar) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(jar.dump()), "utf-8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function loadSessionFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
