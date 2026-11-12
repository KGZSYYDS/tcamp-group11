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

  // 通知列表允许 60 秒内复用，第二次必须命中云端缓存。
  const again = await request(base + "/api/events", { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(again.headers.get("x-szu-cache"), "HIT");

  console.log("Live proxy passed: identical homepage, POST validation, session cookie, static assets, content-length, gzip and entry cache. No school credentials used.");
} finally { child.kill(); }
