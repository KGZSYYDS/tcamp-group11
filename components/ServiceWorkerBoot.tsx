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
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((reg) => {
          // 每次打开都主动问一次有没有新版本，别等浏览器自己想起来
          reg.update().catch(() => undefined);
        })
        .catch(() => {
          /* 注册失败就退化成普通页面，不影响使用 */
        });
    };

    /**
     * 新的 Service Worker 接手后重新加载一次页面。
     *
     * 老页面可能是上一次构建的 HTML，它引用的 JS 分块在新构建里已经 404，
     * 留着只会白屏或点不动。新 SW 已经把旧缓存清掉了，这时刷新正好拿到新页面。
     * 只刷一次，避免和用户自己的刷新互相触发。
     */
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // 等首屏稳定后再注册，别和 hydration 抢主线程
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
