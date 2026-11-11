/**
 * 离线兜底 Service Worker。
 *
 * 为什么需要它：
 * 公网入口在东京，国内访问要过国际链路。实测到入口的 TCP 建连只要 190ms，
 * 但 TLS 握手要 0.5–3.2 秒（正常 TLS1.3 只需两三个往返），说明链路上有丢包。
 * 丢包重传会把握手拖到 5–10 秒，浏览器和微信内置浏览器就直接判超时——
 * 表现就是「间歇性打不开」，刷新一次又好了。
 *
 * 这一层我们改不了（入口是 Tailscale 的）。能改的是「打不开」的后果：
 * 首屏静态资源一旦落到了本地缓存，隧道再抖也不影响页面打开，
 * 用户最多看到数据是旧的，而不是一个浏览器的报错页。
 *
 * 缓存策略：
 *   /_next/static/**   → cache-first。文件名带内容哈希，永不变更，可以放心长期用。
 *   /api/**            → 完全不接管。接口必须拿最新数据，缓存住只会更糟。
 *   页面导航            → network-first，3.5 秒拿不到就用缓存页面。
 *   其它同源资源        → stale-while-revalidate。
 */
const VERSION = "v1";
const STATIC_CACHE = `szu-static-${VERSION}`;
const PAGE_CACHE = `szu-page-${VERSION}`;

/** 导航请求最多等多久就退回缓存。太长等于没兜底，太短会把慢网络上的新版本挡掉。 */
const NAV_TIMEOUT = 3500;

self.addEventListener("install", (event) => {
  // 新版本立刻进入等待转正，别让用户开着旧页面卡住更新
  self.skipWaiting();
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) => cache.add("/").catch(() => undefined))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("szu-") && k !== STATIC_CACHE && k !== PAGE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/** 带超时的请求：超时就返回 null，但不取消原请求，让它继续跑完并写缓存。 */
function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timer);
      return res;
    })
    .catch(() => {
      clearTimeout(timer);
      return null;
    });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // 接口一律交回网络。缓存接口响应会让「通知列表」停在旧数据上，得不偿失。
  if (url.pathname.startsWith("/api/")) return;

  // 静态资源：命中就用缓存，没命中再走网络并写回
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/_next/image")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // 页面导航：先要新的，拿不到再用上次那份
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        const res = await fetchWithTimeout(req, NAV_TIMEOUT);
        if (res && res.ok) {
          cache.put("/", res.clone());
          return res;
        }
        const hit = (await cache.match("/")) || (await cache.match(req));
        if (hit) return hit;
        return res || Response.error();
      })()
    );
    return;
  }

  // 其它（字体、图片、样式）：先用旧的，后台换新的
  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await network) || Response.error();
    })()
  );
});
