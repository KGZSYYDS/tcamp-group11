import http from "node:http";
import https from "node:https";
import { gzipSync, gunzipSync } from "node:zlib";

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

    const startedAt = Date.now();
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
      response.on("end", () => {
        noteFetch(req, startedAt, size, response.statusCode, response.headers["content-encoding"]);
        resolve({
          status: response.statusCode || 502,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(chunks),
        });
      });
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

const CACHE_TTL_MS = 300_000;
const CACHE_STALE_MS = 60 * 60_000;
const REFRESH_INTERVAL_MS = 240_000;
const cache = new Map(); // key -> { at, status, headers, body }
const inflight = new Map(); // key -> Promise，同一路径同时只拉一次
const stats = { fetches: [], warmupFailures: [], startedAt: new Date().toISOString() };

function cacheKey(req) {
  return `${req.method} ${req.url}`;
}

/**
 * 记录最近若干次上游抓取的耗时与字节数。
 * 这段跨境链路有多慢只能从云端实例自己看，本地探测（走内网直达）没有参考价值。
 * 只保存路径、耗时、大小，不含 cookie 与响应体。
 */
function noteFetch(req, startedAt, bytes, status, encoding) {
  stats.fetches.push({
    at: new Date().toISOString(),
    path: req.url,
    ms: Date.now() - startedAt,
    bytes,
    status,
    encoding: encoding || "identity",
  });
  if (stats.fetches.length > 40) stats.fetches.shift();
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
  const running = inflight.get(key);
  if (running) return running;
  const pseudo = { method: req.method, url: req.url, headers: { ...req.headers, "accept-encoding": "gzip" } };
  const task = requestUpstream(pseudo, null)
    .then((upstream) => {
      remember(pseudo, upstream);
      return upstream;
    })
    .catch((error) => {
      console.error("Background refresh failed:", error?.code || error?.message, req.url);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/**
 * 定时刷新通知列表：宁可每 4 分钟在后台安静拉一次，也不要让访客撞上
 * 「缓存刚过期 + 跨境拉 454KB」那一下。上游已压缩，单次只需一百多 KB。
 */
function startRefresher() {
  const tick = () => {
    const pseudo = { method: "GET", url: "/api/events", headers: { "accept-encoding": "gzip" } };
    refreshInBackground(pseudo);
  };
  setInterval(tick, REFRESH_INTERVAL_MS).unref();
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
  const encoding = String(outgoing["content-encoding"] || "").toLowerCase();
  const compressible = /json|javascript|text|xml|css|svg/.test(String(outgoing["content-type"] || ""));
  const clientTakesGzip = wantsGzip(req);

  if (encoding === "gzip" && !clientTakesGzip) {
    // 缓存里留的是压缩过的内容，客户端不接受 gzip 时必须解压后再给，
    // 否则对方拿到的是一包无法解码的字节。
    try {
      payload = gunzipSync(payload);
      delete outgoing["content-encoding"];
    } catch {
      // 解不开就原样放过：宁可让上游内容照旧，也不要回 500。
    }
  } else if (!encoding && compressible && payload.length > 1024 && clientTakesGzip) {
    payload = gzipSync(payload);
    outgoing["content-encoding"] = "gzip";
  }

  if (!outgoing["content-encoding"]) delete outgoing["content-encoding"];
  outgoing.vary = "Accept-Encoding";
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

  // 诊断用：只看入口自己的抓取耗时与缓存状态，不返回任何 cookie 或响应体。
  if (req.url === "/__entry-stats") {
    const entries = [...cache.entries()].map(([key, v]) => ({
      key, ageMs: Date.now() - v.at, bytes: v.body.length,
    }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ startedAt: stats.startedAt, upstream: UPSTREAM.origin, ttlMs: CACHE_TTL_MS, staleMs: CACHE_STALE_MS, entries, fetches: stats.fetches, warmupFailures: stats.warmupFailures }, null, 2));
    return;
  }

  const cached = fromCache(req);
  if (cached) { send(res, cached.entry, req, cached.state); return; }

  // 缓存不可用，但同一路径已经在拉了：跟着那一次走，
  // 不要再开一条跨境连接去抢本就拥挤的带宽。
  if (cacheable(req)) {
    const running = inflight.get(cacheKey(req));
    if (running) {
      const shared = await running;
      if (shared) { send(res, shared, req, "MISS"); return; }
    }
  }

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
  startRefresher();
});

/**
 * 沙箱冷启后第一波访客不该承担整段跨境往返，所以自己先把
 * 通知列表与首页拉进缓存。
 *
 * 串行而不是并发：这条跨境链路单请求固定开销就有好几秒，
 * 并发只会互相抢带宽，把每个请求都拖长。通知列表是关键路径，排第一。
 * 每个目标重试三次——沙箱刚起来时 DNS 与出网未必就绪，一次失败不代表不可用。
 */
async function warmup() {
  for (const url of ["/api/events", "/"]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = Date.now();
      const pseudo = { method: "GET", url, headers: { "accept-encoding": "gzip" } };
      try {
        const upstream = await requestUpstream(pseudo, null);
        remember(pseudo, upstream);
        console.log(`warmup ok: ${url} ${upstream.body.length}B (${Date.now() - startedAt}ms, attempt ${attempt})`);
        break;
      } catch (error) {
        const reason = error?.cause?.code || error?.code || error?.message || "NETWORK";
        stats.warmupFailures.push({ at: new Date().toISOString(), url, attempt, reason, ms: Date.now() - startedAt });
        if (stats.warmupFailures.length > 20) stats.warmupFailures.shift();
        console.error(`warmup failed: ${url} attempt ${attempt}`, reason);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
