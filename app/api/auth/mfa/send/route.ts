import { NextResponse } from "next/server";
import { getMfa } from "@/lib/szu/mfa-store";
import { sendReAuthCode, switchReAuthType, type Trace } from "@/lib/szu/cas";
import { peekOwnerKey } from "@/lib/sessions/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const fail = (status: number, message: string, code?: string, trace: Trace = []) =>
    NextResponse.json({ ok: false, message, code, debug: { trace } }, { status });
  let input: { mfaToken?: unknown; channelType?: unknown };
  try { input = await req.json(); } catch { return fail(400, "请求格式不对"); }
  const owner = peekOwnerKey();
  const pending = owner ? getMfa(String(input.mfaToken ?? ""), owner) : null;
  if (!pending) return fail(410, "登录会话已过期，请重新登录", "MFA_EXPIRED");
  const target = String(input.channelType ?? pending.ctx.reAuthType);
  if (!["3", "4", "5", "11", "12", "13", "15"].includes(target)) return fail(400, "不支持的认证方式");
  const remaining = Math.ceil((120000 - (Date.now() - pending.lastSentAt)) / 1000);
  if (pending.sending || remaining > 0) return fail(429, `请等待 ${Math.max(1, remaining)} 秒后再发送验证码`);
  const trace: Trace = [];
  pending.sending = true;
  try {
    if (target !== pending.ctx.reAuthType && !(await switchReAuthType(pending.jar, pending.ctx, target, trace))) {
      return fail(502, "学校未确认切换成功，本次没有请求发送验证码。请尝试其他方式或在学校官网核对认证设置。", "MFA_CHANNEL", trace);
    }
    pending.lastSentAt = Date.now();
    const sent = await sendReAuthCode(pending.jar, pending.ctx, trace);
    if (!sent.ok) return fail(502, sent.message, "MFA_SEND", trace);
    return NextResponse.json({
      ok: true, channel: pending.ctx.what, phone: sent.mobile,
      message: `学校已受理「${pending.ctx.what}」请求${sent.mobile ? `，接收号码：${sent.mobile}` : ""}。请检查对应渠道；接口成功不代表消息已送达。`,
      debug: { trace },
    });
  } catch {
    return fail(502, "连接学校认证服务失败，请稍后再试", "MFA_SEND", trace);
  } finally {
    pending.sending = false;
  }
}
