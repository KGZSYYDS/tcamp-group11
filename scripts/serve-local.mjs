/**
 * 只把站点跑在固定的本地端口上，不管公网入口。
 *
 * 和 online.mjs 的区别：
 *   online.mjs  = 起服务 + 开 cloudflared 快速隧道（地址每次都变，会被回收）
 *   本脚本      = 只起服务，公网入口交给 Tailscale Funnel（固定域名，重启不变）
 *
 * 所以这个脚本适合被「开机自启」调用：它只需要保证 3000 上一直有个健康的服务，
 * 进程挂了自动拉起来，不需要人工介入。
 *
 * 端口固定为 3000：Tailscale 的 funnel 配置里存的是具体端口，
 * 如果这里随机会挑端口，funnel 就会指到一个空端口上，表现为 502。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const PORT = Number(process.env.SZU_PORT || 3000);
const LOG_DIR = path.join(ROOT, "data", "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const MAX_LOG = 5 * 1024 * 1024;

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* 已存在 */
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    // 超过 5MB 就切一份旧的，避免长期跑把磁盘写满
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    /* 写日志失败不影响主流程 */
  }
}

/** 端口上有没有人监听 */
function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/** 端口上的服务是不是本应用（能返回 2xx/3xx/4xx 就算活着） */
async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  log("没有构建产物（.next/BUILD_ID 不存在）。先跑一次 npm run build:public。");
  process.exit(1);
}

/**
 * 已经有一个健康的实例在跑，就别再起第二个。
 * 开机自启 + 手动点图标 很容易撞车，撞车的结果是第二个进程报端口占用然后退出，
 * 看起来像「启动失败」，其实服务好好的。
 */
if (await portBusy(PORT)) {
  if (await healthy(PORT)) {
    log(`端口 ${PORT} 上已有健康实例，本进程退出（不重复启动）。`);
    process.exit(0);
  }
  log(`端口 ${PORT} 被占用，但响应异常。可能上一个进程正在退出，等 5 秒再试…`);
  await new Promise((r) => setTimeout(r, 5000));
  if (await portBusy(PORT)) {
    log(`端口 ${PORT} 仍被占用。请关掉占用它的程序，或换 SZU_PORT 环境变量。`);
    process.exit(1);
  }
}

let child = null;
let stopping = false;
let restarts = 0;

/**
 * 预热公共通知缓存。
 *
 * 全表 404 行要 1.6–3.1 秒。进程刚起时缓存是空的，第一个访客就得替所有人
 * 等这三秒（同事说的「等一会才行」）。启动后自己先拉一次，让缓存热起来，
 * 之后所有人都是几十毫秒。
 *
 * 失败了不影响服务：那只是让第一个访客多等一下，不该拦住启动。
 */
async function warmup() {
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) {
        const body = await r.json();
        if (Array.isArray(body.events) && body.events.length) {
          log(`预热完成：公共通知 ${body.events.length} 条已进缓存。`);
          return;
        }
        if (body.error) {
          log(`预热未成功（云库：${body.error}），稍后重试。`);
        }
      }
    } catch {
      /* 服务还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * 起 next start 并盯着它。
 * 用固定端口 + 只监听 127.0.0.1：公网流量由 Tailscale 从本机回环转发进来，
 * 不需要把 3000 暴露到局域网。
 */
function startNext() {
  const args = [
    path.join(ROOT, "node_modules", "next", "dist", "bin", "next"),
    "start",
    "-p",
    String(PORT),
    "-H",
    "127.0.0.1",
  ];
  child = spawn(NODE, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      // public 模式：本机磁盘类接口对外关闭，只留登录后按会话读写的部分
      DEPLOY_MODE: "public",
      NEXT_PUBLIC_DEPLOY_MODE: "public",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (b) => log("[next]", b.toString().trim()));
  child.stderr.on("data", (b) => log("[next]", b.toString().trim()));

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    restarts++;
    /**
     * 重启要「第一次几乎立刻、后面才退避」。
     *
     * next 子进程偶尔会以 code 4294967295（-1）退出，原因不明但不影响重启。
     * 原来的首次等待是 3 秒，加上 next 自己的启动时间，公网会连续 4 秒左右全是 502
     * ——在别人眼里就是「链接挂了」。第一次改成 600ms，只有连续崩溃才逐级退避。
     */
    const wait = restarts === 1 ? 600 : Math.min(1500 * Math.min(restarts - 1, 20), 30000);
    log(`[next] 退出了（code ${code}, signal ${signal}），${wait / 1000}s 后重启（第 ${restarts} 次）`);
    setTimeout(() => {
      if (!stopping) startNext();
    }, wait);
  });
}

/**
 * 看门狗：进程还在、但服务已经不响应的情况。
 *
 * `child.on("exit")` 只能兜住「进程死了」。真正难查的是「进程活着但卡死」——
 * 事件循环被堵、内存爆掉之前的长 GC、还是单纯 hang 住。这时端口还连着，
 * Tailscale 转发进来也拿不到响应，用户看到一直转圈，而重启逻辑完全不会触发。
 *
 * 每 20 秒自己打一次首页（3 秒超时），连续 3 次失败就杀掉子进程，
 * 让上面的 exit 处理器把它拉起来。宁可重启一次，也不要让访客一直卡着。
 */
const WATCH_INTERVAL = 20_000;
const WATCH_MAX_FAIL = 3;
let watchFails = 0;

async function watch() {
  if (stopping || !child) return;
  let ok = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
    ok = r.status < 500;
  } catch {
    ok = false;
  }
  if (ok) {
    watchFails = 0;
    return;
  }
  watchFails++;
  log(`看门狗：首页连续 ${watchFails} 次无响应（/ ${WATCH_MAX_FAIL}）`);
  if (watchFails >= WATCH_MAX_FAIL) {
    watchFails = 0;
    log("看门狗：判定服务卡死，杀掉子进程等待重启。");
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经退出就不用管 */
    }
  }
}

setInterval(watch, WATCH_INTERVAL);

log(`启动本地服务：http://127.0.0.1:${PORT}`);
startNext();
void warmup();

const bye = () => {
  stopping = true;
  log("收到退出信号，正在关闭…");
  if (child) child.kill();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
