import http from "node:http";
import https from "node:https";
import { gzipSync } from "node:zlib";

/**
 * 云端轻量转发入口。
 *
 * 链路：访客 → WorkBuddy 网关 → 本进程 → ts.net → 用户电脑上的 Next.js。
 * 学校认证因此仍由用户电脑发起，云端不接触密码、不保存学校会话。
 *
 * 针对「云端 → 东京 ingress → 家里」这段双重国际链路做了三件事：
 *   1. keep-alive 连接复用：避免每个请求重做一次 TLS 握手（该链路握手要 1.4s 以上）。
 *   2. 缓冲后按 content-length 回写：不再把上游的分块直接漏给网关，避免小块写入
 *      在高延迟链路上被放大成几十秒。
 *   3. 回程 gzip（上游未压缩时）：通知列表有 450KB 左右，压缩后约 60KB，
 *      手机端不必等整包。
 */

const UPSTREAM = new URL(process.env.SZU_UPSTREAM || "https://desktop-cbe32mg.tail3d2442.ts.net");
const PUBLIC_ORIGIN = process.env.SZU_PUBLIC_ORIGIN || "https://szu-calendar-38260.app.workbuddy.host";
const PORT = Number(process.env.PORT || 3000);

const upstreamAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 65000,
});

const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
];

function cleanHeaders(source) {
  const headers = { ...source };
  const connectionNames = String(headers.connection || "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP_HEADERS, ...connectionNames]) delete headers[name];
  return headers;
}

function stripGatewayCookie(cookie) {
  if (!cookie) return undefined;
  const kept = cookie.split(";").filter((part) => !part.trim().startsWith("__wb_rsc=")).join(";");
  return kept.trim() ? kept : undefined;
}

/** 上游发来的 set-cookie 在响应头里是数组，逐条还原，避免多个 Set-Cookie 被压扁。 */
function restoreSetCookie(raw) {
  return raw.filter((v) => typeof v === "string" && v.length > 0);
}

function requestUpstream(req, body) {
  return new Promise((resolve, reject) => {
    const headers = cleanHeaders(req.headers);
    headers.host = UPSTREAM.host;
    headers["x-forwarded-host"] = new URL(PUBLIC_ORIGIN).host;
    headers["x-forwarded-proto"] = "https";
    const cookie = stripGatewayCookie(headers.cookie);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    delete headers.expect;
    if (body) headers["content-length"] = String(body.length);

    const request = https.request({
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      path: req.url,
      method: req.method,
      headers,
      agent: upstreamAgent,
      timeout: 65000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        // 超过 8MB 就不再攒，直接交给调用方流式回写。
        if (size > 8 * 1024 * 1024) {
          response.destroy();
          reject(Object.assign(new Error("body-too-large"), { partial: Buffer.concat(chunks) }));
        }
      });
      response.on("end", () => resolve({
        status: response.statusCode || 502,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });

    request.on("timeout", () => request.destroy(new Error("upstream-timeout")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") { resolve(null); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CACHE_TTL_MS = 60_000;
const CACHE_STALE_MS = 15 * 60_000;
const cache = new Map(); // key -> { at, status, headers, body }
const inflight = new Set();

function cacheKey(req) {
  return `${req.method} ${req.url}`;
}

/**
 * 只缓存「公共且允许短暂陈旧」的 GET：通知列表与大块静态资源。
 * 登录态相关接口一律不缓存，否则刚登录完还会读到旧状态。
 */
function cacheable(req) {
  if (req.method !== "GET") return false;
  const url = req.url || "";
  return url.startsWith("/api/events") || url.startsWith("/_next/static/");
}

/**
 * 通知列表过期后先把手上的旧数据返给访客，再后台刷新。
 * 否则每个访客都要等一次「云端 → 东京 → 家里」的完整往返。
 */
function fromCache(req) {
  const key = cacheKey(req);
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age <= CACHE_TTL_MS) return { entry: hit, state: "HIT" };
  if (age > CACHE_STALE_MS) return null;
  refreshInBackground(req);
  return { entry: hit, state: "STALE" };
}

function refreshInBackground(req) {
  const key = cacheKey(req);
  if (inflight.has(key)) return;
  inflight.add(key);
  const pseudo = { method: req.method, url: req.url, headers: { ...req.headers, "accept-encoding": "gzip" } };
  requestUpstream(pseudo, null)
    .then((upstream) => remember(pseudo, upstream))
    .catch((error) => console.error("Background refresh failed:", error?.code || error?.message, req.url))
    .finally(() => inflight.delete(key));
}

function remember(req, entry) {
  if (!cacheable(req)) return;
  if (cache.size > 200) cache.clear();
  cache.set(cacheKey(req), { ...entry, at: Date.now() });
}

function wantsGzip(req) {
  return /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
}

function send(res, { status, headers, body }, req, cacheState) {
  const outgoing = cleanHeaders(headers);
  // 上游的 set-cookie 在这里是数组，必须先还原成多条再写回。
  const rawSetCookie = headers["set-cookie"];
  if (Array.isArray(rawSetCookie) && rawSetCookie.length) outgoing["set-cookie"] = restoreSetCookie(rawSetCookie);
  else delete outgoing["set-cookie"];

  let payload = body;
  const alreadyEncoded = Boolean(outgoing["content-encoding"]);
  const compressible = /json|javascript|text|xml|css|svg/.test(String(outgoing["content-type"] || ""));
  if (!alreadyEncoded && compressible && payload.length > 1024 && wantsGzip(req)) {
    payload = gzipSync(payload);
    outgoing["content-encoding"] = "gzip";
    outgoing.vary = "Accept-Encoding";
  }
  outgoing["content-length"] = String(payload.length);
  delete outgoing["transfer-encoding"];
  outgoing["x-szu-entry"] = "home-funnel-v2";
  if (cacheState) outgoing["x-szu-cache"] = cacheState;
  if (outgoing.location) {
    try {
      const location = new URL(outgoing.location, UPSTREAM);
      if (location.origin === UPSTREAM.origin) outgoing.location = PUBLIC_ORIGIN + location.pathname + location.search + location.hash;
    } catch { /* 无法解析的 location 原样保留 */ }
  }

  res.writeHead(status, outgoing);
  if (req.method === "HEAD" || !payload.length) { res.end(); return; }
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Invalid request path");
    return;
  }

  const cached = fromCache(req);
  if (cached) { send(res, cached.entry, req, cached.state); return; }

  try {
    const body = await collectBody(req);
    const upstream = await requestUpstream(req, body);
    remember(req, upstream);
    send(res, upstream, req, "MISS");
  } catch (error) {
    const reason = error?.cause?.code || error?.code || error?.message || "NETWORK";
    console.error("Upstream connection failed:", reason, req.method, req.url);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("本机服务暂时无法连接，请稍后重试。");
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Calendar entry ready on ${PORT} → ${UPSTREAM.origin}`);
  warmup();
});

/**
 * 沙箱冷启后第一波访客不该承担整段跨境往返，所以自己先把
 * 首页与通知列表拉进缓存；失败无所谓，访客请求会自行重试。
 */
function warmup() {
  for (const url of ["/", "/api/events"]) {
    const pseudo = { method: "GET", url, headers: { "accept-encoding": "gzip" } };
    requestUpstream(pseudo, null)
      .then((upstream) => {
        remember(pseudo, upstream);
        console.log(`warmup ok: ${url} ${upstream.body.length}B`);
      })
      .catch((error) => console.error(`warmup failed: ${url}`, error?.code || error?.message));
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
