/**
 * 凭据与会话（全部在 data/ 下，已被 .gitignore 忽略）
 *
 * 设计原则：**密码不落盘**。
 *
 * 统一身份认证的密码只需要在「建立会话」的那一次用到，之后 30 天内靠 cookie
 * 复用就够了。把密码明文留在磁盘上没有任何收益，只有风险，所以这里：
 *   - 不提供写密码文件的函数
 *   - 遗留的 data/.credentials.json 会在第一次读取时自动清除
 *   - 密码只能从环境变量 / stdin / 交互式输入临时取，进程结束即消失
 *
 * 会话（cookie）仍然缓存：统一认证对短时间内重复登录会返回 401，
 * 每次跑都重登既慢又容易被风控拦，所以按域存一份，失效才重登。
 */
import fs from "fs";
import path from "path";

export const DATA_DIR = path.resolve("data");
/** @deprecated 旧版明文密码文件，只用于识别并清除 */
export const CRED_FILE = path.join(DATA_DIR, ".credentials.json");
export const COOKIE_FILE = path.join(DATA_DIR, ".cookie.txt");

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 删掉历史遗留的明文密码文件。返回是否真的删了东西。 */
export function purgeStoredCredentials() {
  if (!fs.existsSync(CRED_FILE)) return false;
  try {
    fs.unlinkSync(CRED_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 stdin 读一行（用于 `--pass-stdin` 或交互式输入）。
 * 交互式时尽量关掉回显：Windows 的 Git Bash / cmd 下 setRawMode 不一定可用，
 * 失败就退回明文回显 —— 但无论哪种，读到的密码都不会写磁盘。
 */
export function readSecret(prompt = "统一身份认证密码：") {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (stdin.isTTY) {
      stdout.write(prompt);
      try {
        stdin.setRawMode(true);
      } catch {
        /* 不支持就算了 */
      }
      stdin.resume();
      stdin.setEncoding("utf8");

      let buf = "";
      const onData = (ch) => {
        for (const c of ch) {
          if (c === "\r" || c === "\n") {
            stdin.removeListener("data", onData);
            try {
              stdin.setRawMode(false);
            } catch {}
            stdin.pause();
            stdout.write("\n");
            resolve(buf);
            return;
          }
          if (c === "\u0003") {
            stdout.write("\n");
            process.exit(130);
          }
          if (c === "\u007f" || c === "\b") {
            buf = buf.slice(0, -1);
            continue;
          }
          buf += c;
        }
      };
      stdin.on("data", onData);
      return;
    }

    // 非 TTY：从管道读第一行
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (ch) => {
      buf += ch;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        stdin.pause();
        resolve(buf.slice(0, i).replace(/\r$/, ""));
      }
    });
    stdin.on("end", () => resolve(buf.trim()));
    stdin.resume();
  });
}

/**
 * 取一次凭据，用完就扔。
 *
 * 优先级：参数 > 环境变量 > 遗留文件（读完即删）。
 * 返回 { username, password } 或 null。调用方应在使用后自行丢弃引用。
 */
export async function loadCredentials({ user, pass } = {}) {
  let username = user || process.env.SZU_USER || "";
  let password = pass || process.env.SZU_PASS || "";

  // 兼容旧版明文文件：读一次用于本次登录，读完立刻删除，之后不再产生。
  if ((!username || !password) && fs.existsSync(CRED_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
      username = username || raw.username || "";
      password = password || raw.password || "";
      if (username && password) {
        console.warn(
          "⚠ 读到旧版明文密码文件 data/.credentials.json，本次用它登录后已删除。\n" +
            "  以后请用 SZU_USER / SZU_PASS 环境变量传入，密码不再落盘。"
        );
      }
    } catch {}
    purgeStoredCredentials();
  }

  if (!username) {
    throw new Error(
      "缺少统一身份认证账号。先登录一次办事大厅，让采集器建立会话缓存；\n" +
        "或在命令前加 SZU_USER=<学号> SZU_PASS=<密码>（用完即弃，不落盘）。"
    );
  }
  if (!password) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "缺少密码。用 SZU_PASS 环境变量传入，或加 --pass-stdin 从管道读取。\n" +
          "密码只在这个进程里存在，不写磁盘。"
      );
    }
    password = await readSecret();
  }
  return { username, password };
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
// 落盘复用，只在失效时才重新登录。cookie 不是密码：它 30 天自然过期，
// 且换个设备无法使用。

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
