/**
 * GET /api/events —— 公共通知的只读出口。
 *
 * 为什么不让浏览器直接读云库：
 *   现在 404 行、单次约 0.85 秒。一个人用无所谓，公网上 N 个访客就是 N 次全表拉取，
 *   云端和用户两头都在等。这一层把结果放在**服务端进程内**缓存 5 分钟，所有人共享
 *   同一份：无论多少人在看，上游 5 分钟只被问一次。
 *
 * 缓存本身复用 lib/data.ts 的 listEvents()——它在服务端同样是模块级的，
 * 所以这里不需要再写一套 TTL 逻辑。
 *
 * 只回 scope != personal 的行；个人数据从来不在云端这张表里。
 *
 * 为什么自己压 gzip：
 *   公网入口是「云端转发器 → 隧道 → 本机」，这段跨境链路实测只有约 20KB/s。
 *   404 条通知的 JSON 有 454KB，裸传要 21 秒，等于打不开。Next 的自动压缩覆盖不到
 *   route handler 返回的 Response，所以在这里显式压缩：454KB → 约 120KB。
 */
import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { listEvents } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 与 listEvents 的 TTL 对齐，让浏览器/CDN 也敢缓存 */
const MAX_AGE = 300;
const CACHE_CONTROL = `public, max-age=60, s-maxage=${MAX_AGE}, stale-while-revalidate=600`;

/** 压缩结果按原始 JSON 长度做一次短缓存，避免每个请求都重压 454KB */
let gzCache: { rawLength: number; body: Buffer } | null = null;

function gzipBody(raw: string): Buffer {
  if (gzCache && gzCache.rawLength === raw.length) return gzCache.body;
  const body = gzipSync(raw);
  gzCache = { rawLength: raw.length, body };
  return body;
}

export async function GET(req: Request) {
  try {
    const events = await listEvents();
    const raw = JSON.stringify({ events, count: events.length });
    const acceptsGzip = /\bgzip\b/.test(req.headers.get("accept-encoding") || "");

    if (acceptsGzip) {
      const body = gzipBody(raw);
      return new NextResponse(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Content-Length": String(body.length),
          "Cache-Control": CACHE_CONTROL,
          Vary: "Accept-Encoding",
        },
      });
    }

    return new NextResponse(raw, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": CACHE_CONTROL,
        Vary: "Accept-Encoding",
      },
    });
  } catch (e) {
    /**
     * 云库不可用时**不要把接口打成 500**：前端的 listEvents 会退回直连 SDK，
     * 这里回 503 只会让它多走一次错误分支。带上 error 让调用方自己决定。
     */
    return NextResponse.json(
      { events: [], count: 0, error: e instanceof Error ? e.message : "公共通知暂时不可用" },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
