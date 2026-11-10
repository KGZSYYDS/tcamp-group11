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
import { CasError, CookieJar, casLogin, casSsoInto } from "@/lib/szu/cas";
import {
  EHALL_SERVICE,
  JWKW_SERVICE,
  collectTimetable,
  ehallAlive,
  fetchProfile,
} from "@/lib/szu/portal";
import { SESSION_COOKIE, SESSION_DAYS, createSession, saveEhallJar, saveJwkwJar } from "@/lib/szu/session";
import { ownerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, message: string, code?: string, debug?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, message, code, ...(debug ? { debug } : {}) }, { status });
}

/** 只列「域名 + cookie 名」，不含值：够判断会话缺了哪一块，又不会把凭据带出去 */
function jarSummary(jar: CookieJar) {
  return jar
    .dump()
    .map(([domain, pairs]) => `${domain}:${pairs.map(([k]) => k).join(",")}`)
    .join(" | ");
}

export async function POST(req: Request) {
  /**
   * 公网也能登录：CAS cookie 按「这台浏览器」分目录存（data/users/<owner>/），
   * 不再是一个全局文件。以前关掉登录是因为所有人共用一份会话，B 会读到 A 的课表；
   * 分桶之后这个前提不成立了。
   *
   * 仍然要守住的一条：密码只在本次请求里存在，不写盘、不进日志，
   * 服务端长期保存的只有学校发的 cookie（0600，自然过期）。
   */
  const owner = ownerKey();

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

  // 只在出错时回传的诊断信息：不含密码、不含 cookie 值
  const debug: Record<string, unknown> = {};

  try {
    // ① 一次密码登录，落到办事大厅
    const { jar, finalUrl } = await casLogin(studentId, password, EHALL_SERVICE);
    password = "";

    /**
     * ①.5 「CAS 给了 ticket」不等于「办事大厅认了这个会话」。
     *
     * 实测过的失败形态：票据校验那一步 ehall 一次种 4 条 cookie
     * （route / MOD_AUTH_CAS / asessionid / JSESSIONID），如果运行环境把
     * 多条 Set-Cookie 合并成一条、而解析只取第一条，MOD_AUTH_CAS 就丢了，
     * 随后 userInfo.json 直接返回 hasLogin:false —— 看起来像「登录成功但没登录」。
     *
     * 这里先自检；没认就用 TGC 再换一次 ticket（不传密码，不触发重复登录风控）。
     */
    let ehallOk = await ehallAlive(jar);
    if (!ehallOk) {
      debug.ehallRetry = true;
      try {
        await casSsoInto(jar, EHALL_SERVICE);
        ehallOk = await ehallAlive(jar);
      } catch {
        /* 重试也失败就往下统一报错 */
      }
    }
    if (!ehallOk) {
      const probe = new Headers() as unknown as { getSetCookie?: () => string[] };
      debug.node = process.version;
      debug.getSetCookie = typeof probe.getSetCookie === "function";
      debug.landed = String(finalUrl || "").replace(/^https?:\/\//, "").split("?")[0];
      debug.jar = jarSummary(jar);
      return fail(
        502,
        "统一认证通过了，但办事大厅没认这次会话。已自动重试一次仍失败，请把这行下面的 debug 信息发给我",
        "EHALL_SESSION",
        debug
      );
    }

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

    saveEhallJar(owner, jar);
    if (jwkwOk) saveJwkwJar(owner, jar);

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
    return fail(502, message, "PORTAL", Object.keys(debug).length ? debug : undefined);
  }
}
