/**
 * 运行模式：本机跑 vs 公网部署。
 *
 * 这个项目有一半功能是「操作这台电脑」——扫微信目录、取微信密钥、复用统一认证
 * cookie、往公共通知表写数据。这些放在 localhost 上很自然，一旦搬到公网就会变成
 * 三个问题：
 *
 *   1. 串号   服务端把登录态存在 data/ 下的单个文件里，A 登完 B 直接读到 A 的课表。
 *   2. 越权   /api/board/ingest 没有鉴权，谁都能往全校通知表里塞东西。
 *   3. 探针   /api/wechat/config 会把服务器的磁盘结构吐给调用方。
 *
 * 所以公网模式只保留「只读公共数据 + 浏览器本地数据」这条线，本机专属接口一律 403。
 * 判断依据是构建时注入的环境变量，不依赖运行时探测——探测本身也会变成信息泄露面。
 */

export type DeployMode = "local" | "public";

function readMode(): DeployMode {
  // 服务端读 DEPLOY_MODE；客户端读 NEXT_PUBLIC_（构建时内联）。
  // 两个都接受，避免某一边忘了配就静默走错分支。
  const raw = (process.env.NEXT_PUBLIC_DEPLOY_MODE || process.env.DEPLOY_MODE || "")
    .trim()
    .toLowerCase();
  if (raw === "local" || raw === "public") return raw;

  /**
   * 没配置时的兜底：**生产构建一律按公网处理**。
   *
   * 这条兜底的方向很重要。以前默认 local，意味着忘记配环境变量就会把「读本机
   * 微信密钥」「复用统一认证会话」「无鉴权写全校通知表」全部在公网上打开——
   * 配置疏漏直接被放大成安全事故。现在反过来：没配置就等于关掉本机能力，
   * 最坏结果是本地少了几个功能，而不是线上多了一堆后门。
   *
   * 本机开发（next dev）依然是 local，不受影响。
   * 本机跑生产构建（next build && next start）想保留本机功能，显式设 DEPLOY_MODE=local。
   */
  return process.env.NODE_ENV === "production" ? "public" : "local";
}

export const DEPLOY_MODE: DeployMode = readMode();

/** 公网部署时，本机专属能力全部关闭 */
export const IS_PUBLIC_DEPLOY = DEPLOY_MODE === "public";

/** 给用户看的说明，前后端共用同一套措辞 */
export const LOCAL_ONLY_HINT =
  "这项功能需要读写这台电脑上的文件（微信数据、统一认证会话），只在本地运行时可用。公网版本出于安全考虑不开放。";

export function localOnlyMessage(feature: string): string {
  return `${feature}需要访问本机文件，公网版本已关闭。${LOCAL_ONLY_HINT}`;
}
