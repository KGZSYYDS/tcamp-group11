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
 */
import { NextResponse } from "next/server";
import { listEvents } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 与 listEvents 的 TTL 对齐，让浏览器/CDN 也敢缓存 */
const MAX_AGE = 300;

export async function GET() {
  try {
    const events = await listEvents();
    return NextResponse.json(
      { events, count: events.length },
      {
        headers: {
          // s-maxage 给 CDN，stale-while-revalidate 让过期后先给旧值再后台刷新，
          // 避免所有人卡在「缓存刚好过期」的那一瞬间一起穿透到云库。
          "Cache-Control": `public, max-age=60, s-maxage=${MAX_AGE}, stale-while-revalidate=600`,
        },
      }
    );
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
