import { NextResponse } from "next/server";
import { clearSession, loginLms } from "@/lib/szu-lms";
import { ownerKey } from "@/lib/sessions/owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 用统一身份认证登录一次畅课。
 *
 * 密码只在这个请求里存在：不写盘、不写日志、不回显。成功后缓存的是
 * lms 域的 cookie（data/users/<owner>/lms.json，0600），失效了才需要再登一次。
 *
 * 会话按浏览器分桶，所以公网部署也能用——每个人拿到的是自己的那份。
 */
export async function POST(request: Request) {
  const owner = ownerKey();

  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "学号和密码都要填" }, { status: 400 });
  }

  try {
    const r = await loginLms(username, password, owner);
    if (!r.ok) {
      return NextResponse.json({ error: r.message || "登录失败" }, { status: 401 });
    }
    return NextResponse.json({ ok: true, studentId: r.studentId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "登录时出错" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  clearSession(ownerKey());
  return NextResponse.json({ ok: true });
}
