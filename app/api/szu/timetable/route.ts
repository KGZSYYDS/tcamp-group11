/**
 * POST /api/szu/timetable —— 用缓存的 CAS 会话重新拉一次课表。
 *
 * 用途：改了课、换了学期、或者登录时刚好课表接口失败。
 * 只要 cookie jar 还有效就不用再输密码；失效则返回 401，前端提示重新登录。
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  collectTimetable,
  ehallAlive,
  fetchProfile,
  jwkwAlive,
} from "@/lib/szu/portal";
import { SESSION_COOKIE, loadEhallJar, readSession } from "@/lib/szu/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!readSession(cookies().get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, message: "请先登录", code: "UNAUTH" }, { status: 401 });
  }

  const jar = loadEhallJar();
  if (!jar) {
    return NextResponse.json(
      { ok: false, message: "本机没有会话缓存，请重新登录一次", code: "RELOGIN" },
      { status: 401 }
    );
  }

  if (!(await ehallAlive(jar))) {
    return NextResponse.json(
      { ok: false, message: "学校会话已过期，请重新登录一次", code: "RELOGIN" },
      { status: 401 }
    );
  }

  try {
    const profile = await fetchProfile(jar);
    const collected = await collectTimetable(jar);
    return NextResponse.json({
      ok: true,
      timetable: { ...collected.payload, profile },
      jwkwOk: await jwkwAlive(jar),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "课表读取失败";
    return NextResponse.json({ ok: false, message, code: "PORTAL" }, { status: 502 });
  }
}
