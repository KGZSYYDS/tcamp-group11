import { NextResponse } from "next/server";
import { importDdls } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 采集器统一入口。
 * POST /api/import
 * {
 *   "source": "lgyc",            // 采集器标识，如荔园畅课
 *   "items": [
 *     { "course": "计算机导论", "title": "实验4 Python 算法设计",
 *       "dueAt": "2026-11-22T23:59:00+08:00", "url": "...", "note": "..." }
 *   ]
 * }
 * 以 course + title 去重，重复导入只会更新截止时间与链接，不会重置完成状态。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: "items 必须是数组" }, { status: 400 });
    }
    const source = typeof body.source === "string" ? body.source : "import";
    const result = importDdls(body.items, source);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
}
