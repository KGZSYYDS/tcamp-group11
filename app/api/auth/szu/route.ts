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
import {
  CAS_HOST,
  CasError,
  CookieJar,
  casLoginStep,
  casSsoInto,
  sendReAuthCode,
  switchReAuthType,
  traceAdd,
  type Trace,
} from "@/lib/szu/cas";
import { putMfa } from "@/lib/szu/mfa-store";
import {
  EHALL_SERVICE,
  JWKW_SERVICE,
  collectTimetable,
  ehallAlive,
  fetchProfile,
} from "@/lib/szu/portal";
import { SESSION_COOKIE, SESSION_DAYS, createSession, saveEhallJar, saveJwkwJar } from "@/lib/szu/session";
import { saveSession as saveLmsSession, ssoIntoLms } from "@/lib/szu-lms";
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
  const trace: Trace = [];

  try {
    // ① 一次密码登录，落到办事大厅
    const step = await casLoginStep(studentId, password, EHALL_SERVICE, trace);
    password = "";

    /**
     * ① 学校要求二次认证。
     *
     * 服务端每次登录都是全新会话，在学校看来是「非可信浏览器」，于是要一条短信码。
     * 以前这里直接报错、让用户自己去浏览器里登录，等于把难题丢给用户 ——
     * 其实这只是一张表单：发码、收回码、提交，全都能在服务端做完。
     * 用户只需要看一眼手机，把 6 位数字填进来。
     */
    if (step.kind === "mfa") {
      // 学校默认可能给企业微信/今日校园，不是人人都有；先切到短信，切不动就沿用原方式
      if (step.ctx.reAuthType !== "3") {
        await switchReAuthType(step.jar, step.ctx, "3", trace);
      }
      const sent = await sendReAuthCode(step.jar, step.ctx, trace);
      if (!sent.ok) {
        return fail(502, sent.message || "验证码没能发出来，请稍后重试", "MFA_SEND", { trace });
      }
      const mfaToken = putMfa(owner, step.jar, step.ctx, studentId);
      const where = sent.mobile || (step.ctx.reAuthType === "3" ? "你绑定的手机" : step.ctx.what);
      return NextResponse.json({
        ok: false,
        needMfa: true,
        mfaToken,
        phone: sent.mobile,
        channel: step.ctx.what,
        message: `验证码已发到 ${where}，把数字填进来就好`,
      });
    }

    let jar = step.jar;
    let finalUrl = step.finalUrl;

    /**
     * ①.5 「CAS 给了 ticket」不等于「办事大厅认了这个会话」。
     *
     * 票据校验那一步 ehall 一次种 4 条 cookie
     * （route / MOD_AUTH_CAS / asessionid / JSESSIONID），丢一条就不算登录。
     *
     * 重试刻意用「只带 TGC 的干净 jar」而不是复用原 jar：
     * 失败那次 ehall 可能已经种了一个游客 asessionid，带着它重新验票，
     * 有些 SP 会复用那个游客会话、直接忽略新票。清掉才验得干脆。
     */
    let ehallOk = await ehallAlive(jar, trace);
    if (!ehallOk) {
      debug.ehallRetry = true;
      traceAdd(trace, "—— 用干净 jar（只带 TGC）重试 ——");
      try {
        const fresh = jar.subset([CAS_HOST]);
        await casSsoInto(fresh, EHALL_SERVICE, trace);
        if (await ehallAlive(fresh, trace)) {
          jar = fresh;
          ehallOk = true;
        }
      } catch (e) {
        traceAdd(trace, `重试异常 ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!ehallOk) {
      const probe = new Headers() as unknown as { getSetCookie?: () => string[] };
      debug.node = process.version;
      debug.getSetCookie = typeof probe.getSetCookie === "function";
      debug.landed = String(finalUrl || "").replace(/^https?:\/\//, "").split("?")[0];
      debug.jar = jarSummary(jar);
      debug.trace = trace;
      return fail(
        502,
        "统一认证通过了，但办事大厅没认这次会话（已用干净会话重试一次）。请点下方「复制诊断信息」发给我",
        "EHALL_SESSION",
        debug
      );
    }

    // ② 教务系统走单点登录换 ticket —— 不能再登一次，重复登录会被判风控
    let jwkwOk = false;
    let jwkwError: string | undefined;
    try {
      const landed = await casSsoInto(jar, JWKW_SERVICE, trace);
      jwkwOk = Boolean(landed);
    } catch (e) {
      // 教务不可用不影响看课表以外的东西，但要把原因带出去：
      // 专业/班级就是从教务取的，这里失败会表现为「专业为空」而不报错。
      jwkwError = e instanceof Error ? e.message : String(e);
    }

    // ③ 档案是学籍的权威口径，拿不到就不算登录成功
    traceAdd(trace, "—— 读取学籍 ——");
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

    /**
     * ⑤ 顺手把畅课也连上。
     *
     * 畅课（lms.szu.edu.cn）是另一套系统，登录它要再走一遍 CAS。
     * 用户本来得在 DDL 页再输一次学号密码 —— 而公网环境下那又是一次
     * 「非可信浏览器」登录，会再要一条验证码，等于把 MFA 做两遍。
     *
     * 其实不用：这次登录刚拿到的 CAS 票据（TGT）还在有效期内，
     * 拿它单点过去就行。所以放在这里、用同一个 jar，密码一次就够。
     * 失败静默 —— 课表已经拿到了，畅课连不上不该让整次登录翻脸。
     */
    let lmsOk = false;
    try {
      const sso = await ssoIntoLms(jar.dump());
      if (sso.ok) {
        saveLmsSession(owner, sso.jar.dumpLms());
        lmsOk = true;
      }
    } catch {
      // 忽略：LmsSync 卡片里还能手动补
    }

    const { token, payload } = createSession(profile);
    const res = NextResponse.json({
      ok: true,
      user: payload,
      profile,
      timetable,
      warning,
      jwkwOk,
      jwkwError,
      lmsOk,
    });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return res;
  } catch (e) {
    // 任何一步失败都带上轨迹：登录页结构、ticket、每一跳跳转、cookie 名都在里面
    if (e instanceof CasError) {
      const status =
        e.code === "BAD_CREDENTIALS"
          ? 401
          : e.code === "RATE_LIMITED" || e.code === "NEED_CAPTCHA"
            ? 429
            : 502;
      return fail(status, e.message, e.code, trace.length ? { ...debug, trace } : undefined);
    }
    const message = e instanceof Error ? e.message : "登录失败";
    return fail(502, message, "PORTAL", trace.length ? { ...debug, trace } : undefined);
  }
}
