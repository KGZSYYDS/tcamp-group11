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
    // 连续崩溃时退避，避免疯狂重起耗 CPU；上限 60 秒
    const wait = Math.min(3000 * Math.min(restarts, 20), 60000);
    log(`[next] 退出了（code ${code}, signal ${signal}），${wait / 1000}s 后重启（第 ${restarts} 次）`);
    setTimeout(() => {
      if (!stopping) startNext();
    }, wait);
  });
}

log(`启动本地服务：http://127.0.0.1:${PORT}`);
startNext();

const bye = () => {
  stopping = true;
  log("收到退出信号，正在关闭…");
  if (child) child.kill();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
