/**
 * 本机专属接口的统一闸门。
 *
 * 用法：路由处理函数第一行 `const denied = guardLocalOnly("畅课同步"); if (denied) return denied;`
 *
 * 为什么放在路由层而不是中间件：中间件能覆盖的范围更广，但这里要按「接口性质」逐个
 * 标注，跟着路由走最不容易漏——新增一个本机接口时，紧挨着它的 guard 就在眼前。
 */
import { NextResponse } from "next/server";
import { IS_PUBLIC_DEPLOY, localOnlyMessage } from "./runtime-mode";

/**
 * 公网模式下拒绝访问。本机模式下返回 null，调用方继续正常处理。
 * @param feature 面向用户的功能名，会出现在错误信息里
 */
export function guardLocalOnly(feature: string): NextResponse | null {
  if (!IS_PUBLIC_DEPLOY) return null;
  return NextResponse.json(
    { error: localOnlyMessage(feature), code: "LOCAL_ONLY" },
    { status: 403 }
  );
}

/**
 * 写公共数据表的接口还需要一个共享令牌。
 *
 * /api/board/ingest 会往全校可见的 events 表插行，公网暴露等于把「发布全校通知」
 * 的权限给了所有人。令牌走环境变量，没配就直接拒绝——宁可采集脚本用不了，
 * 也不能默认放行。
 */
export function guardIngestToken(request: Request): NextResponse | null {
  const expected = (process.env.INGEST_TOKEN || "").trim();
  if (!expected) {
    return NextResponse.json(
      { error: "未配置 INGEST_TOKEN，写入接口已关闭", code: "INGEST_DISABLED" },
      { status: 503 }
    );
  }
  const header = request.headers.get("authorization") || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-ingest-token")?.trim() || "";
  if (provided !== expected) {
    return NextResponse.json({ error: "写入令牌无效", code: "INGEST_UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}
