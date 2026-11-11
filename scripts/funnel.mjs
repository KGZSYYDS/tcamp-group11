/**
 * 把本机 3000 端口发布成 Tailscale Funnel 的固定公网地址。
 *
 * 和 cloudflared 快速隧道的区别：
 *   快速隧道 → 每次启动换一个新域名，还会被 Cloudflare 回收（地址随时变）
 *   Funnel   → 域名跟着「这台机器 + 这个 tailnet」走，`--bg` 之后重启也不会变
 *
 * 用的是 userspace 之外的标准安装：tailscaled 作为 Windows 服务随开机启动，
 * funnel 配置存在守护进程的状态里，所以机器重启后公网地址照旧。
 * 唯一的前提是本机 3000 端口上有服务在跑（由 serve-local.mjs 负责）。
 *
 * 首次使用要过两道人工确认（Tailscale 的设计，无法自动化）：
 *   1. 登录账号（浏览器打开 tailscale up 给出的链接）
 *   2. 在后台管理页点一下启用 Funnel / HTTPS 证书
 * 脚本会把这两条链接直接打印出来，点完再跑一次即可。
 */
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SZU_PORT || 3000);
const TAILSCALE =
  process.env.TAILSCALE ||
  (existsSync("C:\\Program Files\\Tailscale\\tailscale.exe")
    ? "C:\\Program Files\\Tailscale\\tailscale.exe"
    : "tailscale.exe");

const log = (...a) => console.log(...a);

/** 跑一条 tailscale 命令，同时拿到 stdout 和 stderr（有些提示只在 stderr 里） */
function ts(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(TAILSCALE, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout || "",
        stderr: stderr || "",
        all: (stdout || "") + "\n" + (stderr || ""),
      });
    });
  });
}

if (!existsSync(TAILSCALE) && TAILSCALE !== "tailscale.exe") {
  log("没找到 Tailscale 客户端：" + TAILSCALE);
  log("先装 Tailscale（桌面的安装包），装完再跑这个脚本。");
  process.exit(1);
}

// ---------- 0. 本地服务在不在 ----------
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) });
  if (r.status >= 500) throw new Error("5xx");
} catch {
  log(`本地 ${PORT} 端口没有可用服务。先跑：node scripts/serve-local.mjs`);
  process.exit(1);
}
log(`本地服务正常：http://127.0.0.1:${PORT}`);

// ---------- 1. 登录状态 ----------
const st = await ts(["status", "--json"]);
let status = null;
try {
  status = JSON.parse(st.stdout);
} catch {
  /* 未登录时可能不是 JSON */
}

if (!status || status.BackendState !== "Running") {
  log("\n还没登录 Tailscale。正在发起登录…\n");
  const up = await ts(["up", "--accept-routes=false"], 60000);
  const link = (up.all.match(/https:\/\/login\.tailscale\.com\/[a-z]\/[A-Za-z0-9]+/) || [])[0];
  if (link) {
    log("======================================");
    log("  在浏览器打开这个链接完成登录：");
    log("  " + link);
    log("======================================");
    log("（登录后回到这里再运行一次本脚本）");
  } else {
    log("没能自动登录，输出如下：");
    log(up.all.trim());
  }
  process.exit(2);
}

const dnsName = (status.Self && status.Self.DNSName || "").replace(/\.$/, "");
log("已登录。设备域名：" + (dnsName || "(未知)"));
if (dnsName) log("固定地址应为：https://" + dnsName + "/");

// ---------- 2. 开启 Funnel ----------
log("\n正在把 3000 端口发布到 Funnel…");
const funnel = await ts(["funnel", "--bg", String(PORT)], 90000);

if (funnel.code !== 0) {
  const all = funnel.all;
  // 常见阻断：tailnet 没开 Funnel / 没开 HTTPS 证书 / ACL 不允许
  const enable = (all.match(/https:\/\/login\.tailscale\.com\/f\/[a-z-]+[^\s)]*/) || [])[0];
  if (enable) {
    log("\n======================================");
    log("  还差最后一步：在后台点一下启用");
    log("  " + enable);
    log("======================================");
    log("点完再运行一次本脚本。");
  } else {
    log("开启失败：");
    log(all.trim());
  }
  process.exit(3);
}

// ---------- 3. 读出真正的公网地址 ----------
const fs = await ts(["funnel", "status", "--json"]);
let url = "";
try {
  const j = JSON.parse(fs.stdout);
  // 结构随版本变化，兜底把所有 AllowFunnel 里映射的域名捞出来
  const s = JSON.stringify(j);
  const m = s.match(/https:\/\/([a-z0-9.-]+\.ts\.net)/i);
  if (m) url = "https://" + m[1];
} catch {
  /* 走下面的正则兜底 */
}
if (!url) {
  const m = fs.all.match(/https:\/\/([a-z0-9.-]+\.ts\.net)/i);
  if (m) url = "https://" + m[1];
}
if (!url && dnsName) url = "https://" + dnsName;

if (!url) {
  log("Funnel 已开启，但没能解析出域名。手动看一下输出：");
  log(fs.all.trim());
  process.exit(4);
}

// ---------- 4. 实测能不能打开 ----------
log("\n正在实测公网可达性（首次签证书可能要几十秒）…");
let ok = false;
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.ok || r.status < 500) {
      ok = true;
      break;
    }
  } catch {
    /* 证书还没签好 / DNS 还没生效 */
  }
  await new Promise((r) => setTimeout(r, 3000));
}

const file = path.join(ROOT, "data", "online-url.txt");
try {
  writeFileSync(file, url + "\n", "utf8");
} catch {
  /* 忽略 */
}

log("\n======================================");
log("  固定公网地址：" + url);
log("======================================");
log(ok ? "  已实测可打开。" : "  暂时还没验证通过，等一两分钟再打开试试。");
log("  已写入 data/online-url.txt");

if (ok) {
  const clip = execFile("cmd", ["/c", "clip"], () => {});
  clip.stdin.end(url);
  log("  （已复制到剪贴板）");
}
