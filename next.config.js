// Set only on the cloud entry instance. School authentication then runs on the
// existing home server, through its Funnel URL, rather than in the cloud.
const upstream = process.env.SZU_UPSTREAM_ORIGIN?.trim();
let upstreamOrigin;
if (upstream) {
  const url = new URL(upstream);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash ||
      url.hostname !== "desktop-cbe32mg.tail3d2442.ts.net" || url.port) {
    throw new Error("SZU_UPSTREAM_ORIGIN must be the existing HTTPS Funnel origin");
  }
  upstreamOrigin = url.origin;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Service Worker 自己不能被缓存：否则改了策略老客户端也收不到，
        // 会一直用旧版本的缓存规则（曾导致重建后页面白屏）。
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
  ...(upstreamOrigin ? {
    // beforeFiles includes API routes, public files and Next assets, so the
    // entry instance never accidentally handles login on its own.
    async rewrites() {
      return {
        beforeFiles: [{ source: "/:path*", destination: `${upstreamOrigin}/:path*` }],
        afterFiles: [],
        fallback: [],
      };
    },
  } : {}),
};

module.exports = nextConfig;
