// 深大日历页 content script：把同步载荷转交页面内的 SyncReceiver（同源 postMessage）。
(function () {
  chrome.runtime.sendMessage({ type: "calendar-ready" });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "sync-payload") return;
    window.postMessage(
      { source: "szu-cal-extension", type: "sync", payload: message.payload },
      window.location.origin
    );
  });

  // SyncReceiver 未挂载（通常是未登录）时给出提示
  setTimeout(() => {
    if (!window.__SZU_CAL_RECEIVER__) {
      const banner = document.createElement("div");
      banner.style.cssText =
        "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99999;" +
        "background:#4f46e5;color:#fff;padding:10px 18px;border-radius:10px;" +
        "font:13px/1.6 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18)";
      banner.textContent = "同步助手：请先在深大日历登录，再回到教学平台点「同步到深大日历」";
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 8000);
    }
  }, 3000);
})();
