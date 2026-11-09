/**
 * GET    /api/auth/session —— 查当前这台浏览器是否已登录
 * DELETE /api/auth/session —— 退出（清 cookie）
 *
 * 只读签名 token，不碰学校系统：刷新页面不该再向 authserver 发一次登录请求。
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, readSession } from "@/lib/szu/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = readSession(cookies().get(SESSION_COOKIE)?.value);
  return NextResponse.json({
    user: session
      ? {
          studentId: session.sub,
          name: session.name,
          college: session.college,
          major: session.major,
          grade: session.grade,
          level: session.level,
          expiresAt: new Date(session.exp * 1000).toISOString(),
        }
      : null,
  });
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
