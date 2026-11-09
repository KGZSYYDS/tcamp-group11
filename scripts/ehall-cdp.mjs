/**
 * 用真实 Chrome（headless + CDP）打开一个 SPA 页面，抓它实际发出的 XHR。
 * 金智 ehall / jwkw 都是前端渲染，纯 HTTP 只能拿到空壳，靠它定位数据接口。
 *
 * 不依赖 playwright：直接用 Node 22 内置 WebSocket 说 CDP 协议。
 *
 * 用法：
 *   node scripts/ehall-cdp.mjs                                  # 默认：办事大厅「我的课表」
 *   node scripts/ehall-cdp.mjs --url "<页面 URL>" --service "<CAS service>"
 *   node scripts/ehall-cdp.mjs --url "https://jwkw.szu.edu.cn/jwapp/sys/homeapp/home/index.html" \
 *        --service "https://jwkw.szu.edu.cn/jwapp/sys/homeapp/index.do"
 * 抓到的请求写 data/tmp/cdp-requests.log，模块接口的响应体写 data/tmp/api-*.json。
 */
import { spawn } from "child_process";
import { casLogin } from "./lib/cas.mjs";
import { loadCredentials } from "./lib/session.mjs";
import fs from "fs";
import os from "os";
import path from "path";

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(opt("port", "9333"));
const PROFILE = path.join(process.cwd(), "data/tmp/chrome-profile");
const SERVICE = opt("service", "https://ehall.szu.edu.cn:443/amp/login");
const APP_URL = opt("url", "https://ehall.szu.edu.cn/appShow?appId=4770397878132218");
const WAIT = Number(opt("wait", "9000"));
const TARGET_HOST = new URL(APP_URL).hostname;

fs.mkdirSync(PROFILE, { recursive: true });

const cred = await loadCredentials();
const login = await casLogin(cred.username, cred.password, SERVICE);
const cookies = (login.jar.dump().find(([d]) => d === TARGET_HOST) || [])[1] || [];
console.log("目标:", APP_URL);
console.log("cookie 数:", cookies.length);

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore", detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome 调试端口未就绪");
}

const ver = await waitPort();
console.log("浏览器:", ver.Browser);

// 新建标签页
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const requests = new Map(); // requestId -> {url, method, type}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "Network.requestWillBeSent") {
    const { requestId, request, type } = msg.params;
    requests.set(requestId, { url: request.url, method: request.method, type, postData: request.postData });
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024 });
await send("Page.enable");

for (const [name, value] of cookies) {
  await send("Network.setCookie", { name, value, domain: TARGET_HOST, path: "/" });
}

await send("Page.navigate", { url: APP_URL });
await sleep(WAIT);

// 抓所有 .do 请求
const dots = [...requests.entries()].filter(([, r]) => /\.do\b|\.json\b/.test(r.url));
console.log("捕获请求:", requests.size, "其中 .do/.json:", dots.length);

const headList = [];
for (const [id, r] of dots) {
  const body = await send("Network.getResponseBody", { requestId: id });
  const txt = body.result?.body || "";
  const line = `${r.method} ${r.url.replace(/;jsessionid=[^?]*/, "").slice(0, 130)} → ${txt.length}B ${txt.slice(0, 90).replace(/\s+/g, " ")}`;
  console.log(line);
  fs.appendFileSync("data/tmp/cdp-requests.log", line + "\n");

  // 关键接口：保存完整请求头 + 请求体 + 响应体（按 URL 去重）
  if (/\/modules\//.test(r.url) && !headList.some((h) => h.url.split("?")[0] === r.url.split("?")[0])) {
    const hdrs = await send("Network.getRequestHeaders", { requestId: id }).catch(() => null);
    headList.push({ url: r.url, method: r.method, postData: r.postData, headers: hdrs?.result?.headers });
    const tag = r.url.match(/modules\/(\w+)\/(\w+)\.do/);
    if (tag) fs.writeFileSync(`data/tmp/api-${tag[1]}-${tag[2]}.json`, txt, "utf-8");
  }
}
fs.writeFileSync("data/tmp/api-requests.json", JSON.stringify(headList, null, 2), "utf-8");

// 页面标题与文本
const title = await send("Runtime.evaluate", { expression: "document.title" });
const text = await send("Runtime.evaluate", { expression: "document.body.innerText.slice(0,500)" });
console.log("标题:", title.result?.result?.value);
console.log("正文:", (text.result?.result?.value || "").replace(/\s+/g, " ").slice(0, 300));

ws.close();
chrome.kill();
process.exit(0);
