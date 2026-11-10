/**
 * POST /api/auth/cookies —— 导入用户在浏览器里登录后拿到的会话 cookie。
 *
 * 为什么不在这里收密码 / 不收 CAS 票据：学校按登录地点风控，机房 IP 一旦
 * 去碰 CAS 就会被要求二次认证（短信/企业微信），机器过不去。但登录完成之后
 * 办事大厅和教务自己发的会话 cookie 不经过 CAS，服务端拿它直接请求业务接口
 * 就能用。详见 lib/szu/cookie-import.ts。
 *
 * 安全边界：
 *   - 收到的 cookie 用来建会话，**不回显、不进日志**（诊断轨迹里只记域名和名字）
 *   - 落盘的会话文件按浏览器分目录，和密码登录那条路一致
 */
import { NextResponse } from "next/server";
import { jarFromCookies, looksLikeCookies } from "@/lib/szu/cookie-import";
import { collectTimetable, ehallAlive, fetchProfile, jwkwAlive } from "@/lib/szu/portal";
import { SESSION_COOKIE, SESSION_DAYS, createSession, saveEhallJar, saveJwkwJar } from "@/lib/szu/session";
import { ownerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const owner = ownerKey();

  let input: { ehall?: unknown; jwkw?: unknown };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "请求格式不对" }, { status: 400 });
  }

  const ehallRaw = String(input.ehall ?? "");
  const jwkwRaw = String(input.jwkw ?? "");

  if (!looksLikeCookies(ehallRaw, "ehall")) {
    return NextResponse.json(
      {
        ok: false,
        message: "没认出办事大厅的 cookie。请确认复制的是请求头里的 Cookie 那一整行（应包含 JSESSIONID 之类）",
        code: "BAD_COOKIE",
      },
      { status: 400 }
    );
  }

  const trace: string[] = [];
  try {
    const jar = jarFromCookies(ehallRaw, jwkwRaw);

    if (!(await ehallAlive(jar, trace))) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "这份办事大厅会话已经失效了。请回到浏览器刷新一次办事大厅，确认还处于登录状态，再重新复制。",
          code: "EHALL_COOKIE",
          debug: { trace },
        },
        { status: 502 }
      );
    }

    const profile = await fetchProfile(jar);
    const jwkwOk = jwkwRaw.trim() ? await jwkwAlive(jar) : false;

    let timetable = null;
    let warning: string | undefined;
    try {
      const collected = await collectTimetable(jar);
      timetable = { ...collected.payload, profile };
    } catch (e) {
      warning = e instanceof Error ? e.message : "课表读取失败";
    }

    saveEhallJar(owner, jar);
    if (jwkwOk) saveJwkwJar(owner, jar);

    const { token, payload } = createSession(profile);
    const res = NextResponse.json({ ok: true, user: payload, profile, timetable, warning, jwkwOk });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return res;
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        message: e instanceof Error ? e.message : "会话导入失败",
        code: "COOKIE",
        debug: { trace },
      },
      { status: 502 }
    );
  }
}
