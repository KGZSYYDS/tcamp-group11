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

/**
 * 隧道要能自愈。
 *
 * 免费快速隧道会被 Cloudflare 回收（日志里是 `Unauthorized: Tunnel not found`），
 * 或者 QUIC（UDP 7844）在校园网/某些宽带上根本出不去
 * （`write udp ... unreachable network`）。这两种都会让地址静默变成 530。
 *
 * 所以：先按 QUIC 起，连不上就换 HTTP/2（走 TCP 443）；已经发出的地址失效了就重开一个，
 * 打印新地址。用户只需要保持窗口开着，不用自己发现「怎么打不开了」。
 */
const PROTOCOLS = ["quic", "http2"];
let protocolIndex = 0;
let tunnel = null;
let announced = false;
let stopping = false;

/**
 * 等地址真的能用，再告诉用户。
 *
 * cloudflared 会**先打印地址、后完成注册**，这中间有几十秒窗口期：
 * 地址看着有了，DNS 还没写入，打开就是「找不到服务器」。
 * 之前就是在这个窗口期把地址发出去了，用户拿到的是死链。
 * 所以这里用真实请求验证，200 才算通了。
 */
async function verifyPublic(url, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok || r.status < 500) return true;
    } catch {
      /* DNS 还没生效 / 隧道还没注册 */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

function announce(url) {
  const file = path.join(ROOT, "data", "online-url.txt");
  try {
    writeFileSync(file, url + "\n", "utf8");
  } catch {
    /* 目录不存在就跳过 */
  }
  log("\n======================================");
  log("  公网地址：" + url);
  log("======================================");
  log("  （已写入 data/online-url.txt，已实测可打开）");
  log("  这个窗口别关。关掉网址就失效了。\n");
  // 顺手复制到剪贴板，省得手抄
  const clip = spawn("cmd", ["/c", "clip"], { stdio: ["pipe", "ignore", "ignore"] });
  clip.stdin.end(url);
}

/** 本次尝试抓到的地址（还没验证） */
let pendingUrl = "";

function scan(chunk) {
  const text = chunk.toString();
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && !pendingUrl) pendingUrl = m[0];
}

/**
 * 起一条隧道，并且**等它真的能访问**才算成功。
 * resolve(false) 表示这次尝试失败，由外层换协议或重试。
 */
function startTunnel(protocol) {
  pendingUrl = "";
  const t = spawn(
    CLOUDFLARED,
    ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate", "--protocol", protocol],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  tunnel = t;

  t.stdout.on("data", scan);
  t.stderr.on("data", (b) => {
    const s = b.toString();
    if (/Tunnel not found/i.test(s)) {
      t.emit("recycled");
      return;
    }
    if (/ERR/i.test(s) && !/trycloudflare/i.test(s) && !/Retrying connection/i.test(s)) {
      process.stderr.write("[tunnel] " + s);
    }
    scan(b);
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(ok);
    };

    // 每 2 秒看一眼：地址出现了就去实测，实测过了才算连通
    let checking = false;
    const timer = setInterval(async () => {
      if (!pendingUrl || checking) return;
      checking = true;
      const ok = await verifyPublic(pendingUrl, 6);
      checking = false;
      if (ok) {
        announced = true;
        announce(pendingUrl);
        done(true);
      }
    }, 2000);

    t.once("exit", () => done(false));
    t.once("recycled", () => done(false));

    // 兜底：两分钟还验不通就换下一种协议
    setTimeout(() => {
      if (!settled) {
        log("[隧道] 两分钟内没能连通，换一种协议再试…");
        if (!t.killed) t.kill();
        done(false);
      }
    }, 120000);
  });
}

/** 起隧道并在失败时换协议、换新地址重试，直到成功或用户关闭窗口 */
async function ensureTunnel() {
  let attempt = 0;
  while (!stopping) {
    const protocol = PROTOCOLS[protocolIndex % PROTOCOLS.length];
    announced = false;
    log(`[隧道] 尝试 ${protocol}（第 ${attempt + 1} 次）…`);
    const ok = await startTunnel(protocol);
    if (ok) {
      log(`[隧道] 已连通（${protocol}）`);
      return;
    }
    // 同一种协议连续失败两次就换一种，避免在坏路径上死循环
    if (attempt % 2 === 1) protocolIndex++;
    attempt++;
    if (tunnel && !tunnel.killed) tunnel.kill();
    await new Promise((res) => setTimeout(res, 2000));
  }
}

await ensureTunnel();

/**
 * 隧道进程意外退出（或被回收）时自动重开。
 * 重开拿到的是**新地址**，必须重新打印出来告诉用户。
 */
function watchTunnel() {
  if (!tunnel) return;
  tunnel.once("exit", () => {
    if (stopping) return;
    const wasAnnounced = announced;
    log(
      wasAnnounced
        ? "\n[tunnel] 隧道断了（地址已被回收），正在换一个新地址…"
        : "\n[tunnel] 隧道断了，正在重连…"
    );
    // 换协议再试：同一个网络下同一种协议往往还是连不上
    protocolIndex++;
    void ensureTunnel().then(watchTunnel);
  });
}
watchTunnel();

const bye = () => {
  stopping = true;
  log("\n正在关闭…");
  if (tunnel) tunnel.kill();
  next.kill();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
