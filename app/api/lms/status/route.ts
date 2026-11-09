import { NextResponse } from "next/server";
import { loadSession, sessionAgeDays } from "@/lib/szu-lms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 畅课会话状态。
 *
 * 只回「有没有缓存的会话、多久前登的」，不回 cookie 内容。
 * 前端据此决定显示「一键同步」还是「先登录一次」。
 */
export async function GET() {
  const jar = loadSession();
  const age = sessionAgeDays();
  return NextResponse.json({
    loggedIn: Boolean(jar),
    ageDays: age === null ? null : Math.round(age * 10) / 10,
  });
}
