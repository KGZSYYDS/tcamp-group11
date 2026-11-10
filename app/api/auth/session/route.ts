/**
 * GET    /api/auth/session —— 查当前这台浏览器是否已登录
 * DELETE /api/auth/session —— 退出（清 cookie）
 *
 * 只读签名 token，不碰学校系统：刷新页面不该再向 authserver 发一次登录请求。
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, clearOwnerSessions, readSession } from "@/lib/szu/session";
import { peekOwnerKey } from "@/lib/sessions/owner";

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
  /**
   * 退出要连服务端的 cookie 桶一起清掉。
   *
   * 只清浏览器 token 的话，学校系统那份 cookie 还留在磁盘上：共用设备时下一个人
   * 虽然看不到你的名字，但「重新同步课表」仍会用你的会话去取数据。既然会话是按
   * 浏览器分桶的，退出就该把桶端掉。
   */
  const owner = peekOwnerKey();
  if (owner) clearOwnerSessions(owner);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
