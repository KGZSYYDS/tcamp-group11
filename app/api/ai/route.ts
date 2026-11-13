import { NextResponse } from "next/server";
import { publicConfig } from "@/lib/cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 固定转发到已有模型网关，让公网和本机使用同一条解析路径。 */
async function forward(request: Request, body?: string) {
  try {
    const response = await fetch(
      `${publicConfig.endpoint}/.cloud/llm/${body === undefined ? "models" : "chat/completions"}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Wb-Webapp-Access-Key": publicConfig.publishableKey,
        },
        body,
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
      }
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[ai] 模型网关连接失败", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: { message: "AI 服务暂时连接失败，请稍后重试", type: "server_error" } },
      { status: 502 }
    );
  }
}

export async function GET(request: Request) {
  return forward(request);
}

export async function POST(request: Request) {
  let input;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "解析请求格式错误" } }, { status: 400 });
  }
  if (typeof input?.model !== "string" || !Array.isArray(input?.messages) || !input.messages.length) {
    return NextResponse.json({ error: { message: "请选择模型并提供待解析内容" } }, { status: 400 });
  }
  return forward(request, JSON.stringify(input));
}
