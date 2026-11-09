import { NextResponse } from "next/server";
import { weflowStatus } from "@/lib/wechat-local";

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
 */
export async function GET() {
  return NextResponse.json(weflowStatus());
}
