/**
 * 在本机把站点跑起来，再用隧道映射到公网。
 *
 * 为什么这么做（而不是部署到云上）：
 * 学校的统一认证按「发起请求的机器」判断是否可信。云服务器在上海机房，
 * 对学校来说是陌生地点 + 陌生设备，每次登录都要短信二次认证。
 * 让程序跑在**自己电脑**上，请求就从自己的网络发出，和本机开发时完全一样，
 * 之前在本机验证通过的那套东西（会话文件、课表、登录态）可以原样复用。
 *
 * 这个脚本做三件事：
 *   1. 起 Next 生产服务（public 模式下本机磁盘类的接口保持关闭）
 *   2. 起 cloudflared 隧道，把本地端口映射成一个公网地址
 *   3. 把公网地址打出来、写进文件、复制到剪贴板
 */
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const CLOUDFLARED = process.env.CLOUDFLARED || path.join(process.env.USERPROFILE || "", "bin", "cloudflared.exe");

/** 端口空着吗 */
function free(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

/**
 * 3000 被占（比如上次的窗口没关干净）就往后找。
 * 直接报错让用户去杀进程，对不懂命令行的人太不友好。
 */
async function pickPort() {
  const want = Number(process.env.PORT || 3000);
  for (let p = want; p < want + 20; p++) {
    if (await free(p)) return p;
  }
  return null;
}

const PORT = await pickPort();
if (!PORT) {
  console.log("3000 附近 20 个端口都被占用了，可能上次的窗口还开着。");
  console.log("把之前那个黑色窗口关掉，再重新运行。");
  process.exit(1);
}

const log = (...a) => console.log(...a);

/**
 * 没有构建产物就自己构建一次。
 * 「请先运行 npm run build:online」这种提示，对不懂命令行的人等于卡死。
 */
if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  log("第一次启动，正在打包（大概一两分钟，别关窗口）…\n");
  const code = await new Promise((resolve) => {
    const b = spawn(NODE, [path.join(ROOT, "scripts", "build-online.mjs")], { cwd: ROOT, stdio: "inherit" });
    b.on("exit", resolve);
  });
  if (code !== 0) {
    log("\n打包没成功，把上面的报错截图发给开发者。");
    process.exit(1);
  }
  log("\n打包完成。\n");
}
if (!existsSync(CLOUDFLARED)) {
  log("找不到 cloudflared：" + CLOUDFLARED);
  process.exit(1);
}

// ---------- 1. Next ----------
const next = spawn(NODE, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "production", DEPLOY_MODE: "public", NEXT_PUBLIC_DEPLOY_MODE: "public" },
  stdio: ["ignore", "pipe", "pipe"],
});
next.stdout.on("data", (b) => process.stdout.write("[next] " + b));
next.stderr.on("data", (b) => process.stderr.write("[next] " + b));
next.on("exit", (code) => {
  log(`\n[next] 退出了（code ${code}）`);
  process.exit(code ?? 1);
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitReady())) {
  log("本地服务没能起来，看看上面的报错");
  next.kill();
  process.exit(1);
}
log(`\n本地已就绪：http://127.0.0.1:${PORT}`);

// ---------- 2. 隧道 ----------
log("正在建立公网隧道（首次可能要十几秒）…\n");
const tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let announced = false;
function scan(chunk) {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !announced) {
    announced = true;
    const url = m[0];
    const file = path.join(ROOT, "data", "online-url.txt");
    try {
      writeFileSync(file, url + "\n", "utf8");
    } catch {
      /* 目录不存在就跳过 */
    }
    log("\n======================================");
    log("  公网地址：" + url);
    log("======================================");
    log("  （已写入 data/online-url.txt）");
    log("  这个窗口别关。关掉网址就失效了。\n");
    // 顺手复制到剪贴板，省得手抄
    const clip = spawn("cmd", ["/c", "clip"], { stdio: ["pipe", "ignore", "ignore"] });
    clip.stdin.end(url);
  }
}
tunnel.stdout.on("data", scan);
tunnel.stderr.on("data", (b) => {
  const s = b.toString();
  if (/ERR|error/i.test(s) && !/trycloudflare/i.test(s)) process.stderr.write("[tunnel] " + s);
  scan(b);
});
tunnel.on("exit", (code) => {
  log(`\n[tunnel] 退出了（code ${code}），公网地址已失效`);
  next.kill();
  process.exit(code ?? 1);
});

const bye = () => {
  log("\n正在关闭…");
  tunnel.kill();
  next.kill();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
