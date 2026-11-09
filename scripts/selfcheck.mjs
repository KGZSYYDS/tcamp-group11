#!/usr/bin/env node
/**
 * 登录 / 畅课 一键自检。
 *
 * 它本身不连学校系统，只驱动本地已启动的 Next 服务，走的正是浏览器那条路：
 *   路由 → lib/szu/* → cookie
 * 因此顺带验证了 cookie 是否设对、会话签名是否生效，比直接调库更接近真实使用。
 *
 * 用法：
 *   npm run dev                          # 终端 A
 *   node scripts/selfcheck.mjs           # 终端 B
 *
 *   SZU_USER=2024xxxx SZU_PASS=*** node scripts/selfcheck.mjs
 *   node scripts/selfcheck.mjs --base http://localhost:3001
 *   node scripts/selfcheck.mjs --skip-lms
 *
 * 安全：
 *   - 密码不回显、不落盘、不打印；登录后立即清空
 *   - 只允许 localhost / 127.0.0.1，拒绝其它主机（防止密码被发到外网）
 *   - 不自动重试（重复登录会被学校风控）
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

const HELP = `登录 / 畅课 一键自检

用法：
  node scripts/selfcheck.mjs [选项]

选项：
  --base <url>    本地服务地址，默认 http://localhost:3000
  --skip-lms      跳过畅课两步
  --timeout <ms>  单步超时，默认 60000
  -h, --help      显示本说明

凭据：
  优先读环境变量 SZU_USER / SZU_PASS；没有则交互输入（密码不回显）。
  只允许连 localhost，密码不会被发到外网。
`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

const BASE = arg("base", process.env.SELFCHECK_BASE || "http://localhost:3000").replace(/\/$/, "");
const SKIP_LMS = process.argv.includes("--skip-lms");
const TIMEOUT = Number(arg("timeout", "60000"));

let baseUrl;
try {
  baseUrl = new URL(BASE);
} catch {
  console.error(`--base 不是合法地址：${BASE}`);
  process.exit(2);
}
if (!LOCAL_HOSTS.has(baseUrl.hostname)) {
  console.error(
    `拒绝执行：--base 只能指向本机（localhost / 127.0.0.1），收到的是 ${baseUrl.hostname}。\n` +
      "这是为了防止学号密码被发到外部服务器。"
  );
  process.exit(2);
}

/* ---------- 小工具 ---------- */

const t0 = Date.now();
let stepStart = t0;
const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
/** 单步耗时：每次调用后重置，避免显示成累计时间 */
const elapsed = () => {
  const ms = Date.now() - stepStart;
  stepStart = Date.now();
  return fmtMs(ms);
};

const cookies = new Map();
function storeCookies(res) {
  const list = res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const raw of list) {
    const pair = String(raw).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

async function call(path, options = {}) {
  const res = await fetch(`${baseUrl.origin}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...(cookies.size ? { cookie: cookieHeader() } : {}) },
    signal: AbortSignal.timeout(options.timeout || TIMEOUT),
  });
  storeCookies(res);
  return res;
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function maskId(id) {
  return id.length <= 4 ? "****" : `${id.slice(0, 4)}${"*".repeat(Math.max(0, id.length - 6))}${id.slice(-2)}`;
}

/* ---------- 交互输入 ---------- */

function promptLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(String(chunk).trim());
    };
    stdin.once("data", onData);
  });
}

/** 密码输入不回显，只打星号 */
function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

/* ---------- 步骤 ---------- */

const results = [];
let failed = null;

function ok(label, detail) {
  results.push({ label, ok: true, detail: detail || "" });
  console.log(`  ✓ ${label.padEnd(12, " ")} ${elapsed().padStart(6)}   ${detail || ""}`);
}

function bad(label, detail, hint) {
  results.push({ label, ok: false, detail: detail || "", hint });
  console.log(`  ✗ ${label.padEnd(12, " ")} ${elapsed().padStart(6)}   ${detail || ""}`);
  if (hint) {
    for (const line of String(hint).split("\n")) console.log(`      → ${line}`);
  }
  failed = { label, detail, hint };
}

/** 把接口返回的错误码翻译成"下一步怎么办" */
function hintFor(code, message, scope) {
  if (scope === "lms") {
    if (/还没登录/.test(message)) return "畅课会话为空，先跑步骤 5（登录畅课）";
    if (/过期/.test(message)) return "畅课会话过期：DELETE /api/lms/login 清掉后重跑";
    return "把上面这行消息发我，多半是畅课页面结构变了";
  }
  switch (code) {
    case "BAD_INPUT":
      return "学号或密码格式不对（学号要 6–16 位数字），本地就被拦下，没有发到学校。";
    case "BAD_CREDENTIALS":
      return "学号或密码不对。先用浏览器登一次 authserver.szu.edu.cn 确认能进。";
    case "NEED_CAPTCHA":
      return "账号被要求图形验证码，脚本过不去。先在浏览器登录一次，再重跑。";
    case "RATE_LIMITED":
      return "短时间重复登录被风控。等 30–60 分钟，别重试——脚本也不会自动重试。";
    case "PORTAL":
      return "办事大厅返回异常，多半是页面结构变了。把上面的消息发我。";
    default:
      return "把上面这行消息发我。";
  }
}

async function main() {
  console.log(`\n服务：${baseUrl.origin}\n`);

  /* 0. 服务可达 */
  try {
    const res = await call("/api/auth/session", { timeout: 8000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok("服务可达");
  } catch (e) {
    bad("服务可达", e?.message || "连接失败", "先在一个终端跑 npm run dev，等它显示 Ready 再跑本脚本。");
    return finish();
  }

  /* 凭据 */
  let user = process.env.SZU_USER || "";
  let pass = process.env.SZU_PASS || "";
  if (!user || !pass) {
    if (!process.stdin.isTTY) {
      bad("读取凭据", "非交互环境且没有 SZU_USER / SZU_PASS", "用环境变量传入，例如：\nSZU_USER=2024xxxx SZU_PASS=*** node scripts/selfcheck.mjs");
      return finish();
    }
    console.log("");
    if (!user) user = await promptLine("学号：");
    if (!pass) pass = await promptHidden("统一认证密码（不回显）：");
    console.log("");
  }

  /* 1. 统一认证登录 */
  let loginBody = null;
  try {
    const res = await call("/api/auth/szu", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ studentId: user, password: pass }),
      timeout: 90000,
    });
    loginBody = await json(res);
    pass = ""; // 用完立刻清掉
    if (!res.ok || !loginBody.ok) {
      const code =
        loginBody.code ||
        (res.status === 400
          ? "BAD_INPUT"
          : res.status === 401
            ? "BAD_CREDENTIALS"
            : res.status === 429
              ? "RATE_LIMITED"
              : "PORTAL");
      bad("统一认证登录", `${res.status} ${code}  ${loginBody.message || ""}`.trim(), hintFor(code, loginBody.message));
      return finish();
    }
    ok("统一认证登录", `学号 ${maskId(loginBody.profile?.studentId || user)}`);
  } catch (e) {
    pass = "";
    bad("统一认证登录", e?.message || "请求失败", "网络或超时问题，重跑一次；仍失败把消息发我。");
    return finish();
  }

  /* 2. 会话落库（cookie 是否生效） */
  try {
    const res = await call("/api/auth/session");
    const body = await json(res);
    if (!body.user) {
      bad("会话落库", "登录成功但读不到会话", "cookie 没设上或签名校验失败，检查 .env 里 SESSION_SECRET 是否稳定。");
      return finish();
    }
    ok("会话落库", `${body.user.name || "（无姓名）"} · ${body.user.college || "（无学院）"}`);
  } catch (e) {
    bad("会话落库", e?.message || "请求失败", "把消息发我。");
    return finish();
  }

  /* 3. 档案（来自登录响应，不额外请求） */
  const p = loginBody.profile || {};
  if (p.name || p.college) {
    ok("档案", `${p.grade || "—"} · ${p.levelName || "—"}${p.major ? ` · ${p.major}` : ""}`);
    if (!loginBody.jwkwOk) {
      // 专业/班级来自教务，教务没连上时这两个字段一定为空
      console.log(
        `      → 教务单点未成功${loginBody.jwkwError ? `（${loginBody.jwkwError}）` : ""}；课表不受影响`
      );
    } else if (!p.major) {
      // 教务接口本身就只给姓名/学号/学期/周次，别让使用者以为哪里坏了
      console.log("      → 专业/班级教务接口不提供，留空正常；学院与年级过滤不受影响");
    }
  } else {
    bad("档案", "登录成功但档案为空", "学籍接口口径可能变了（userInfo.json），把上面消息发我。");
  }

  /* 4. 课表（同上） */
  const tt = loginBody.timetable;
  if (tt?.counts) {
    ok("课表", `${tt.counts.courses} 门课 / ${tt.counts.sessions} 次 · ${tt.termName || tt.term || "本学期"}`);
  } else if (loginBody.warning) {
    bad("课表", loginBody.warning, "课表失败不阻塞登录，但要看原因：多半是教务会话或接口变了。");
  } else {
    bad("课表", "登录成功但没返回课表", "collectTimetable 可能被跳过，把消息发我。");
  }

  if (SKIP_LMS) return finish();
  if (!process.env.SZU_PASS && !pass) {
    // 密码已在步骤 1 清空；畅课需要再输一次
    if (!process.stdin.isTTY) {
      bad("畅课登录", "跳过：密码已清空且非交互", "想测畅课就用环境变量传 SZU_PASS。");
      return finish();
    }
    pass = await promptHidden("畅课也用同一个密码？再输一次（不回显）：");
  }

  /* 5. 畅课登录 */
  try {
    const res = await call("/api/lms/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
      timeout: 90000,
    });
    const body = await json(res);
    pass = "";
    if (!res.ok || !body.ok) {
      bad("畅课登录", `${res.status} ${body.error || ""}`.trim(), hintFor(null, body.error || "", "lms"));
      return finish();
    }
    ok("畅课登录", `学号 ${maskId(body.studentId || user)}`);
  } catch (e) {
    pass = "";
    bad("畅课登录", e?.message || "请求失败", "把消息发我。");
    return finish();
  }

  /* 6. 畅课作业 */
  try {
    const res = await call("/api/lms/ddls");
    const body = await json(res);
    if (!res.ok) {
      bad("畅课作业", `${res.status} ${body.error || ""}`.trim(), hintFor(null, body.error || "", "lms"));
      return finish();
    }
    const n = body.total ?? body.items?.length ?? 0;
    if (n === 0) {
      ok("畅课作业", "接口通了，但这学期没有待办");
    } else {
      const sample = (body.items || []).slice(0, 2).map((x) => x.title).join(" / ");
      ok("畅课作业", `${n} 条待办 · ${sample}`);
    }
  } catch (e) {
    bad("畅课作业", e?.message || "请求失败", "把消息发我。");
  }

  return finish();
}

function finish() {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  console.log("");
  if (!failed) {
    console.log(`全部通过：${passed}/${total}`);
    process.exit(0);
  }
  console.log(`通过 ${passed}/${total}，断在「${failed.label}」`);
  console.log("上面带 → 的那行就是下一步该做的。");
  process.exit(1);
}

main().catch((e) => {
  console.error("\n脚本自身出错：", e?.message || e);
  process.exit(1);
});
