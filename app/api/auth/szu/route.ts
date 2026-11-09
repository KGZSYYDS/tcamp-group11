/**
 * POST /api/auth/szu —— 用学号 + 统一认证密码登录，顺手把课表和档案取回来。
 *
 * 为什么登录和取课表绑在一起：这两件事都需要同一次 CAS 会话。分成两步做，
 * 用户就得登录两次、或者跑一遍命令行再导入文件。既然登录已经建立了会话，
 * 那就一次把数据带到前端，登录完直接有课表。
 *
 * 密码在这一层只有三个动作：校验非空 → 交给 casLogin → 变量清空。
 * 不写日志、不进数据库、不落任何文件。
 */
import { NextResponse } from "next/server";
import { CasError, casLogin, casSsoInto } from "@/lib/szu/cas";
import {
  EHALL_SERVICE,
  JWKW_SERVICE,
  collectTimetable,
  fetchProfile,
} from "@/lib/szu/portal";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  createSession,
  saveEhallJar,
  saveJwkwJar,
} from "@/lib/szu/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code?: string) {
  return NextResponse.json({ ok: false, message, code }, { status });
}

export async function POST(req: Request) {
  let input: { studentId?: unknown; password?: unknown };
  try {
    input = await req.json();
  } catch {
    return fail(400, "请求格式不对");
  }

  let studentId = String(input.studentId ?? "").trim();
  let password = String(input.password ?? "");

  if (!/^\d{6,16}$/.test(studentId)) {
    return fail(400, "学号是 6–16 位数字，别填手机号或校园卡号");
  }
  if (!password) return fail(400, "请填统一认证密码");

  try {
    // ① 一次密码登录，落到办事大厅
    const { jar } = await casLogin(studentId, password, EHALL_SERVICE);
    password = "";

    // ② 教务系统走单点登录换 ticket —— 不能再登一次，重复登录会被判风控
    let jwkwOk = false;
    let jwkwError: string | undefined;
    try {
      const landed = await casSsoInto(jar, JWKW_SERVICE);
      jwkwOk = Boolean(landed);
    } catch (e) {
      // 教务不可用不影响看课表以外的东西，但要把原因带出去：
      // 专业/班级就是从教务取的，这里失败会表现为「专业为空」而不报错。
      jwkwError = e instanceof Error ? e.message : String(e);
    }

    // ③ 档案是学籍的权威口径，拿不到就不算登录成功
    const profile = await fetchProfile(jar);
    if (!profile.studentId) profile.studentId = studentId;

    // ④ 课表：失败可以让用户稍后重试，不该把整个登录堵死
    let timetable = null;
    let warning: string | undefined;
    try {
      const collected = await collectTimetable(jar);
      timetable = { ...collected.payload, profile };
    } catch (e) {
      warning = e instanceof Error ? e.message : "课表读取失败";
    }

    saveEhallJar(jar);
    if (jwkwOk) saveJwkwJar(jar);

    const { token, payload } = createSession(profile);
    const res = NextResponse.json({
      ok: true,
      user: payload,
      profile,
      timetable,
      warning,
      jwkwOk,
      jwkwError,
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return res;
  } catch (e) {
    if (e instanceof CasError) {
      const status = e.code === "BAD_CREDENTIALS" ? 401 : e.code === "RATE_LIMITED" ? 429 : 502;
      return fail(status, e.message, e.code);
    }
    const message = e instanceof Error ? e.message : "登录失败";
    return fail(502, message, "PORTAL");
  }
}
