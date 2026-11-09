import { NextResponse } from "next/server";
import { invalidateStatus, keyJobState, startKeyJob, weflowStatus } from "@/lib/wechat-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 微信密钥（WeFlow 读加密库的钥匙）。
 *
 * GET  → 现在这个后台任务跑到哪了
 * POST → 起一个后台任务：weflow key db --save --timeout 600
 *
 * 这一步必须用户在微信里**退出重登**，WeFlow 才拿得到新的密钥，
 * 所以是「起任务 → 让用户去操作 → 回来轮询」的节奏，不是同步等结果。
 * WeFlow 的输出可能含密钥，这里一个字都不返回。
 */
export async function GET() {
  return NextResponse.json({ job: keyJobState(), status: weflowStatus() });
}

export async function POST() {
  const r = startKeyJob();
  invalidateStatus();
  return NextResponse.json(r, { status: r.started ? 200 : 503 });
}
