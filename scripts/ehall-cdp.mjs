/**
 * 用真实 Chrome（headless + CDP）打开办事大厅「我的课表」，
 * 抓取页面实际发出的 .do 请求与响应，用于定位课表数据接口。
 *
 * 不依赖 playwright：直接用 Node 22 内置 WebSocket 说 CDP 协议。
 */
import { spawn } from "child_process";
import { casLogin } from "./lib/cas.mjs";
import { loadCredentials } from "./lib/session.mjs";
import fs from "fs";
import os from "os";
import path from "path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const PROFILE = path.join(process.cwd(), "data/tmp/chrome-profile");
const APP_URL = "https://ehall.szu.edu.cn/appShow?appId=4770397878132218";

fs.mkdirSync(PROFILE, { recursive: true });

const cred = loadCredentials();
const login = await casLogin(cred.username, cred.password, "https://ehall.szu.edu.cn:443/amp/login");
const ehallCookies = (login.jar.dump().find(([d]) => d === "ehall.szu.edu.cn") || [])[1] || [];
console.log("cookie 数:", ehallCookies.length);

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

for (const [name, value] of ehallCookies) {
  await send("Network.setCookie", { name, value, domain: "ehall.szu.edu.cn", path: "/" });
}

await send("Page.navigate", { url: APP_URL });
await sleep(9000);

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

  // 关键接口：保存完整请求头 + 请求体 + 响应体
  if (/xskcb\/xskcb\.do|dqxnxq\.do|cxjcgx\.do/.test(r.url) && !headList.some((h) => h.url === r.url)) {
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
