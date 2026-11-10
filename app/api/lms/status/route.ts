import { NextResponse } from "next/server";
import { loadSession, sessionAgeDays } from "@/lib/szu-lms";
import { peekOwnerKey } from "@/lib/sessions/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 畅课会话状态。
 *
 * 只回「有没有缓存的会话、多久前登的」，不回 cookie 内容。
 * 前端据此决定显示「一键同步」还是「先登录一次」。
 *
 * 会话按浏览器分桶，所以这里查的是「你这台浏览器」的状态，不是全局的。
 */
export async function GET() {
  const owner = peekOwnerKey();
  if (!owner) {
    // 从没登录过：不给他种 cookie，直接说没有
    return NextResponse.json({ loggedIn: false, ageDays: null });
  }

  const jar = loadSession(owner);
  const age = sessionAgeDays(owner);
  return NextResponse.json({
    loggedIn: Boolean(jar),
    ageDays: age === null ? null : Math.round(age * 10) / 10,
  });
}
