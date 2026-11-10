import { NextResponse } from "next/server";
import { loadSession, sessionAgeDays } from "@/lib/szu-lms";
import { IS_PUBLIC_DEPLOY } from "@/lib/runtime-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 畅课会话状态。
 *
 * 只回「有没有缓存的会话、多久前登的」，不回 cookie 内容。
 * 前端据此决定显示「一键同步」还是「先登录一次」。
 *
 * 公网模式下回 200 + disabled，而不是 403：前端拿到 403 只会当成「没登录」，
 * 于是仍会把密码框摆出来，用户填完才被告知不能登录。这里直接让它别渲染。
 */
export async function GET() {
  if (IS_PUBLIC_DEPLOY) {
    return NextResponse.json({ loggedIn: false, ageDays: null, disabled: true });
  }

  const jar = loadSession();
  const age = sessionAgeDays();
  return NextResponse.json({
    loggedIn: Boolean(jar),
    ageDays: age === null ? null : Math.round(age * 10) / 10,
  });
}
