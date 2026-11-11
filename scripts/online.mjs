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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const PORT = Number(process.env.PORT || 3000);
const CLOUDFLARED = process.env.CLOUDFLARED || path.join(process.env.USERPROFILE || "", "bin", "cloudflared.exe");

const log = (...a) => console.log(...a);

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  log("还没构建过。先跑一次：npm run build:online");
  process.exit(1);
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
