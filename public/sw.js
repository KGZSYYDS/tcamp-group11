/**
 * 离线兜底 Service Worker。
 *
 * 缓存策略：
 *   /_next/static/**   → cache-first。文件名带内容哈希，内容不会变，可以长期用。
 *   /api/**            → 完全不接管。接口必须拿最新数据。
 *   页面导航            → network-first。**不设人为超时**，拿不到才用缓存页。
 *   其它同源资源        → stale-while-revalidate。
 *
 * 为什么导航不再设 3.5 秒超时（v1 的教训）：
 *   每次重新构建，HTML 引用的 JS 分块哈希都会变，旧分块随即 404。
 *   v1 为了抗抖动，3.5 秒拿不到就走缓存，结果把「上一次构建的 HTML」发给了用户，
 *   页面去请求已经 404 的旧脚本 → 白屏。云端转发入口已经在边缘缓存首页（1 秒内），
 *   人为压低超时收益很小、代价却是整页崩掉，所以这里改成让浏览器自己等。
 *   缓存页只在真的连不上时才用，那时显示旧页面总好过浏览器报错页。
 *
 * 改了这份文件后，**必须同步改 VERSION**，否则老客户端不会清掉旧缓存。
 */
const VERSION = "v2";
const STATIC_CACHE = `szu-static-${VERSION}`;
const PAGE_CACHE = `szu-page-${VERSION}`;

self.addEventListener("install", (event) => {
  // 新版本立刻转正，别让用户开着旧页面卡住更新
  self.skipWaiting();
  event.waitUntil(caches.open(STATIC_CACHE).catch(() => undefined));
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

  // 接口一律交回网络
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
          // 只缓存成功响应：404 的旧分块不能被记住，否则下次部署前一直白屏
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // 页面导航：先要新的，确实拿不到才用上次那份
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            cache.put("/", res.clone());
            return res;
          }
          const hit = await cache.match("/");
          return hit || res;
        } catch {
          const hit = await cache.match("/");
          return hit || Response.error();
        }
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
