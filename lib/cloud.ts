import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";

// 来自 workbuddy_cloud_service activate 返回的 publicConfig（可随前端代码发布）
const publicConfig = {
  endpoint: "https://szu-calendar.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy",
};

export const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey,
});
