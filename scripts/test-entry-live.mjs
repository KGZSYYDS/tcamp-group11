import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const base = "http://127.0.0.1:18372";
const child = spawn(process.execPath, ["output/workbuddy-entry/server.mjs"], {
  env: { ...process.env, PORT: "18372" }, stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", chunk => process.stderr.write(chunk));
try {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("proxy startup timed out")), 10000);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`proxy exited: ${code}`)));
    child.stdout.once("data", () => { clearTimeout(deadline); resolve(); });
  });
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  const [direct, proxied] = await Promise.all([
    request("https://desktop-cbe32mg.tail3d2442.ts.net/"), request(base + "/"),
  ]);
  assert.equal(direct.status, 200);
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get("x-szu-entry"), "home-funnel-v2");
  const a = await direct.text(), b = await proxied.text();
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(a), hash(b), "proxy must return the exact home page");
  const invalid = await request(base + "/api/auth/szu", {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: "__wb_rsc=not-forwarded" },
    body: JSON.stringify({ studentId: "invalid" }),
  });
  assert.equal(invalid.status, 400, "invalid student ID must reach home validation");
  assert.equal((await invalid.json()).ok, false);
  assert.match(invalid.headers.get("set-cookie") || "", /szu_owner=/, "home session cookie must survive proxy");
  const asset = b.match(/(?:src|href)="(\/_next\/static\/[^\"]+)"/);
  assert.ok(asset);
  assert.equal((await request(base + asset[1])).status, 200);

  // 大响应必须带 content-length（不再分块漏给网关），且支持 gzip 回程压缩。
  const events = await request(base + "/api/events", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(events.status, 200);
  assert.ok(events.headers.get("content-length"), "large response must carry content-length");
  assert.equal(events.headers.get("content-encoding"), "gzip", "JSON must be gzip-compressed on the way back");
  const payload = await events.json();
  assert.ok(Array.isArray(payload.events), "/api/events must return an events array");

  // 通知列表允许 5 分钟内复用，第二次必须命中入口缓存。
  const again = await request(base + "/api/events", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(again.headers.get("x-szu-cache"), "HIT");

  // 缓存里存的是压缩内容，客户端不声明 gzip 时必须解压后再给，
  // 否则对方拿到的是一包解不开的字节。
  const plain = await request(base + "/api/events", { headers: { "Accept-Encoding": "identity" } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("content-encoding"), null, "identity client must not receive gzip bytes");
  assert.ok(Array.isArray((await plain.json()).events));

  // 诊断接口：只报抓取耗时，不含 cookie 或响应体。
  const stats = await request(base + "/__entry-stats");
  assert.equal(stats.status, 200);
  const info = await stats.json();
  assert.ok(Array.isArray(info.fetches) && info.fetches.length > 0, "stats must record upstream fetches");
  assert.ok(!JSON.stringify(info).includes("cookie"), "stats must not leak cookies");

  console.log("Live proxy passed: identical homepage, POST validation, session cookie, static assets, content-length, gzip (both directions), entry cache and stats. No school credentials used.");
} finally { child.kill(); }
