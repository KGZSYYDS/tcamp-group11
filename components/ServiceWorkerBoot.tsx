"use client";

import { useEffect } from "react";

/**
 * 注册离线兜底 Service Worker（见 public/sw.js）。
 *
 * 只在生产构建里注册：开发时缓存住 `/_next/static` 会导致改代码看不到效果，
 * 这是最经典的「改了没反应」来源。
 *
 * 失败完全不影响功能，只是少了一层兜底，所以整段静默处理。
 */
export default function ServiceWorkerBoot() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const secure =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!secure) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 注册失败就退化成普通页面，不影响使用 */
      });
    };

    // 等首屏稳定后再注册，别和 hydration 抢主线程
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
