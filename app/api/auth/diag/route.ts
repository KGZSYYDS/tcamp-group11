/**
 * GET /api/auth/diag —— 登录链路只读自检。
 *
 * 为什么需要它：线上报「统一认证通过但办事大厅不认」时，无法区分是
 *   ① 部署环境根本连不上学校站点（出网被限制 / 需要用代理）
 *   ② 连得上，但票据换会话那一步没种下 cookie
 *   ③ 学校页面结构变了（找不到 pwdEncryptSalt）
 * 这三种病要三种完全不同的修法，而它们的表象都是同一句报错。
 *
 * 这个接口不发密码、不建会话、不写任何文件，只做三次 GET，报告「通不通、结构对不对」。
 * 不返回任何 cookie 值，只返回 cookie 名。
 *
 * 只供本机排查。结果含运行机器的出口 IP，同一实例每 15 秒可运行一次。
 */
import { NextResponse } from "next/server";
import { guardLocalOnly } from "@/lib/local-only";
import { CAS_HOST, CookieJar, requestWith } from "@/lib/szu/cas";
import { EHALL, JWKW } from "@/lib/szu/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOLDOWN_MS = 15_000;
let lastRun = 0;

async function probe(jar: CookieJar, url: string) {
  const started = Date.now();
  try {
    const res = await requestWith(jar, url);
    const text = await res.text();
    return {
      url: `${new URL(url).hostname}${new URL(url).pathname}`,
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      bytes: text.length,
      cookies: jar.namesFor(new URL(url).hostname),
      body: text,
    };
  } catch (e) {
    return {
      url: `${new URL(url).hostname}${new URL(url).pathname}`,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      body: "",
    };
  }
}

export async function GET() {
  const denied = guardLocalOnly("登录链路诊断");
  if (denied) return denied;

  const now = Date.now();
  if (now - lastRun < COOLDOWN_MS) {
    return NextResponse.json(
      { ok: false, message: `自检有冷却，${Math.ceil((COOLDOWN_MS - (now - lastRun)) / 1000)} 秒后再试` },
      { status: 429 }
    );
  }
  lastRun = now;

  const jar = new CookieJar();

  // ① 统一认证登录页：能不能拿到，且结构还是不是原来那个
  const login = await probe(jar, `https://${CAS_HOST}/authserver/login?service=`);
  const hasSalt = /id="pwdEncryptSalt"\s+value="([^"]*)"/.test(login.body);
  const hasExecution =
    /id="execution"\s+name="execution"\s+value="/.test(login.body) || /name="execution"\s+value="/.test(login.body);

  // ② 办事大厅：未登录时应当返回 JSON 且带 hasLogin 字段
  const ehall = await probe(jar, `${EHALL}/jsonp/userInfo.json`);
  const ehallJson = (() => {
    try {
      return JSON.parse(ehall.body);
    } catch {
      return null;
    }
  })();

  // ③ 教务：只判断可达性
  const jwkw = await probe(jar, `${JWKW}/jwapp/sys/homeapp/index.do`);

  /**
   * ④ 出口 IP 归属地。
   *
   * 不是为了统计，是为了解释一个具体现象：统一认证对「境外 / 机房 IP」会插入
   * reAuthCheck 二次认证，而二次认证必须人工完成，服务端永远过不去。
   * 沙箱若在境外，这里会直接显示出来，省得再猜。
   */
  let egress: Record<string, unknown> = { ok: false };
  try {
    const r = await fetch("https://myip.ipip.net", {
      headers: { "User-Agent": "curl/8" },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const text = (await r.text()).trim();
    egress = { ok: r.ok, text: text.slice(0, 200) };
  } catch (e) {
    egress = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(
    {
      ok: true,
      at: new Date().toISOString(),
      runtime: {
        node: process.version,
        getSetCookie: typeof (new Headers() as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function",
      },
      authserver: {
        reachable: login.ok,
        status: login.status ?? null,
        ms: login.ms,
        bytes: login.bytes ?? 0,
        hasSalt,
        hasExecution,
        cookies: login.cookies ?? [],
        ...(login.error ? { error: login.error } : {}),
      },
      ehall: {
        reachable: ehall.ok,
        status: ehall.status ?? null,
        ms: ehall.ms,
        isJson: Boolean(ehallJson),
        hasLoginField: Boolean(ehallJson && "hasLogin" in ehallJson),
        hasLogin: ehallJson?.hasLogin ?? null,
        ...(ehall.error ? { error: ehall.error } : {}),
      },
      jwkw: {
        reachable: jwkw.ok,
        status: jwkw.status ?? null,
        ms: jwkw.ms,
        ...(jwkw.error ? { error: jwkw.error } : {}),
      },
      egress,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
