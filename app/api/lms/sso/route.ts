/**
 * POST /api/lms/sso —— 用已经登录的统一认证会话，把畅课也连上（不碰密码）。
 *
 * 畅课是另一套系统，正常要再输一次学号密码。但用户刚登录过统一认证，
 * 那枚 CAS 票据还在的话，直接换票就能进去 —— 少一次输入，也少一次验证码。
 *
 * 票据有生命周期：太久没登录就会过期，这时如实告诉用户去重新登录，
 * 而不是让他在这里反复输密码（公网模式下那又会触发二次认证）。
 */
import { NextResponse } from "next/server";
import { loadEhallJar } from "@/lib/szu/session";
import { saveSession as saveLmsSession, ssoIntoLms } from "@/lib/szu-lms";
import { ownerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const owner = ownerKey();

  const ehall = loadEhallJar(owner);
  if (!ehall) {
    return NextResponse.json(
      { ok: false, needsRelogin: true, error: "还没登录统一认证，先在上面用学号密码登录" },
      { status: 401 }
    );
  }

  try {
    const sso = await ssoIntoLms(ehall.dump());
    if (sso.ok) {
      saveLmsSession(owner, sso.jar.dumpLms());
      return NextResponse.json({ ok: true });
    }

    /**
     * 票据过期是最常见的情况，且无法在服务端补救（补登录等于再走一次密码 + MFA）。
     * 所以把「下一步点哪里」直接写进消息里。
     */
    return NextResponse.json(
      {
        ok: false,
        needsRelogin: true,
        error: "统一认证的登录已过有效期。到「我的」页退出，再用学号密码登录一次，畅课会一起连上",
      },
      { status: 409 }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "连接畅课失败" },
      { status: 502 }
    );
  }
}
