import { NextResponse } from "next/server";
import { weflowStatusNow } from "@/lib/wechat-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 本机微信通道是否可用。
 *
 * 这个接口只在「网页跑在用户自己电脑上」时有意义：部署到云端的实例
 * 后面没有微信库，会返回 available:false —— 前端据此把自动通道收起、
 * 只留手动导入。不做「假装可用」的降级。
 *
 * 不返回 exe 路径和完整 wxid：前端用不到，少暴露一点是一点。
 *
 * 注意：这里**不能**同步探测。探测要依次跑 `--version`（超时 20s）和
 * `db test`（超时 60s），同步执行会把 Node 主线程占满，整站页面和其它接口
 * 一起停住。所以首次请求先回 stage:"probing"，真探测在后台跑，前端轮询取结果。
 */
export async function GET() {
  return NextResponse.json(weflowStatusNow());
}
