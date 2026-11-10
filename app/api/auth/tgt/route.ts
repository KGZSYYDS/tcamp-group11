/**
 * POST /api/auth/tgt —— 用用户在浏览器里登录统一认证后得到的 CASTGC 建立会话。
 *
 * 为什么不在这里收密码：学校的风控按登录地点算。服务端在机房、用户在城市另一头，
 * 密码登录会被要求二次认证，机器过不去（详见 lib/szu/tgt.ts 的说明）。
 * 而 TGT 不绑 IP，所以让用户在自己浏览器里完成验证，只把票据交过来。
 *
 * 安全边界：
 *   - 收到的 CASTGC 只用于本次换票，**不写文件、不进日志**
 *   - 落盘的是换来的办事大厅会话，按浏览器分目录，和密码登录那条路一样
 *   - 响应里不回显票据
 */
import { NextResponse } from "next/server";
import { loginWithTgt, looksLikeTgt, ssoJwkw } from "@/lib/szu/tgt";
import { collectTimetable, fetchProfile } from "@/lib/szu/portal";
import { SESSION_COOKIE, SESSION_DAYS, createSession, saveEhallJar, saveJwkwJar } from "@/lib/szu/session";
import { ownerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const owner = ownerKey();

  let input: { tgt?: unknown };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "请求格式不对" }, { status: 400 });
  }

  let tgt = String(input.tgt ?? "").trim();
  // 用户常把 "CASTGC=" 或整行 "CASTGC=TGT-x; Path=/" 一起复制进来，这里兜一下
  tgt = tgt.replace(/^CASTGC\s*=\s*/i, "").split(";")[0].trim();

  if (!looksLikeTgt(tgt)) {
    return NextResponse.json(
      {
        ok: false,
        message: "这不像一个登录票据。它应该以 TGT- 开头，长约 90 个字符",
        code: "BAD_TGT",
      },
      { status: 400 }
    );
  }

  const trace: string[] = [];
  try {
    const jar = await loginWithTgt(tgt, trace);
    tgt = "";

    const profile = await fetchProfile(jar);

    // 课表要用教务的周次锚点，没有它整学期会错位
    const jwkwOk = await ssoJwkw(jar, trace);

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
        message: e instanceof Error ? e.message : "票据登录失败",
        code: "TGT",
        debug: { trace },
      },
      { status: 502 }
    );
  }
}
