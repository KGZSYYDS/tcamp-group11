import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

// 来自 workbuddy_cloud_service activate 返回的 publicConfig（可随前端代码发布）
export const publicConfig = {
  endpoint: "https://szu-calendar.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy",
};

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
  fetch: (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // 模型网关按 Origin 限制跨域，公网浏览器经同源接口调用。
    if (
      typeof window !== "undefined" &&
      url.origin === publicConfig.endpoint &&
      ["/.cloud/llm/models", "/.cloud/llm/chat/completions"].includes(url.pathname)
    ) {
      return fetch("/api/ai", { ...init, credentials: "same-origin" });
    }
    return fetch(input, init);
  },
});
