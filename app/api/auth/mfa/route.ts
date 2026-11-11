/**
 * POST /api/auth/mfa —— 提交短信/企业微信验证码，把二次认证走完。
 *
 * 这是「学校要求多因子」时登录的第二半。第一步 /api/auth/szu 拿到密码后
 * 被 CAS 拦在 reAuth 页，服务端已经把验证码发到用户手机上并保留了 CAS 会话；
 * 用户在这里填入 6 位数字，服务端替他把表单提交掉，然后照常取档案和课表。
 *
 * 用户视角只有一句话：输一下手机上收到的验证码。不用开开发者工具、
 * 不用复制任何 cookie、也不用管浏览器在哪个网络。
 */
import { NextResponse } from "next/server";
import { CAS_HOST, CasError, casSsoInto, submitReAuthCode, traceAdd, type Trace } from "@/lib/szu/cas";
import { EHALL_SERVICE, JWKW_SERVICE, collectTimetable, ehallAlive, fetchProfile } from "@/lib/szu/portal";
import { dropMfa, getMfa } from "@/lib/szu/mfa-store";
import { SESSION_COOKIE, SESSION_DAYS, createSession, saveEhallJar, saveJwkwJar } from "@/lib/szu/session";
import { saveSession as saveLmsSession, ssoIntoLms } from "@/lib/szu-lms";
import { ownerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code?: string, debug?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, message, code, ...(debug ? { debug } : {}) }, { status });
}

export async function POST(req: Request) {
  const owner = ownerKey();

  let input: { mfaToken?: unknown; code?: unknown };
  try {
    input = await req.json();
  } catch {
    return fail(400, "请求格式不对");
  }

  const token = String(input.mfaToken ?? "").trim();
  const code = String(input.code ?? "").replace(/\s/g, "");

  if (!token) return fail(400, "登录状态已失效，请重新输入密码登录");
  if (!/^\d{4,8}$/.test(code)) return fail(400, "验证码是一串数字，通常是 6 位");

  const pending = getMfa(token, owner);
  if (!pending) {
    return fail(
      410,
      "这次登录等太久了，验证码已过期。请重新输入密码登录一次",
      "MFA_EXPIRED"
    );
  }

  const trace: Trace = [];
  try {
    // ① 把验证码交给学校，通过后 CAS 才放 ticket
    const { jar } = await submitReAuthCode(pending.jar, pending.ctx, code, trace);

    // ② 和密码登录一样：ticket 拿到了，还要确认办事大厅真的认这个会话
    let ehallOk = await ehallAlive(jar, trace);
    if (!ehallOk) {
      traceAdd(trace, "—— 用干净 jar（只带 TGC）重试 ——");
      try {
        const fresh = jar.subset([CAS_HOST]);
        await casSsoInto(fresh, EHALL_SERVICE, trace);
        if (await ehallAlive(fresh, trace)) ehallOk = true;
      } catch (e) {
        traceAdd(trace, `重试异常 ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!ehallOk) {
      return fail(502, "验证通过了，但办事大厅没认这次会话，请重新登录一次", "EHALL_SESSION", { trace });
    }

    dropMfa(token);

    // ③ 教务走单点登录，课表的周次锚点要靠它
    let jwkwOk = false;
    try {
      jwkwOk = Boolean(await casSsoInto(jar, JWKW_SERVICE, trace));
    } catch {
      /* 教务不可用不该堵死登录 */
    }

    // ④ 档案 + 课表
    const profile = await fetchProfile(jar);
    if (!profile.studentId) profile.studentId = pending.studentId;

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

    // ⑤ 顺手把畅课也连上（同 szu 路由：趁票据还新鲜，别让用户再登一次）
    let lmsOk = false;
    try {
      const sso = await ssoIntoLms(jar.dump());
      if (sso.ok) {
        saveLmsSession(owner, sso.jar.dumpLms());
        lmsOk = true;
      }
    } catch {
      /* 畅课连不上不影响登录 */
    }

    const { token: session, payload } = createSession(profile);
    const res = NextResponse.json({ ok: true, user: payload, profile, timetable, warning, jwkwOk, lmsOk });
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return res;
  } catch (e) {
    if (e instanceof CasError && e.code === "MFA_BAD") {
      // 输错不算失败：会话还在，让用户改一位再提交
      return fail(400, e.message, "MFA_BAD", { trace });
    }
    const message = e instanceof Error ? e.message : "验证失败";
    return fail(502, message, "MFA", { trace });
  }
}
