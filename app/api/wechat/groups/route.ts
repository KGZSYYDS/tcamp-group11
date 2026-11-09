import { NextResponse } from "next/server";
import { findWeFlow, listGroups, scoreGroup, weflowStatus } from "@/lib/wechat-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 列出本机微信的群，按「像不像会发通知的群」排序。
 *
 * 227 个群里绝大多数是家教、二手、奶茶群。靠用户自己在列表里翻找是反产品的，
 * 所以带上分数由前端默认勾选前几个；分数只影响排序和默认勾选，不影响能不能选。
 */
export async function GET() {
  const s = weflowStatus();
  if (!s.available) {
    return NextResponse.json({ error: s.error || "本机没有可用的微信通道" }, { status: 503 });
  }
  const exe = findWeFlow();
  if (!exe) return NextResponse.json({ error: "找不到 WeFlow" }, { status: 503 });

  try {
    const groups = listGroups(exe)
      .map((g) => ({ ...g, score: scoreGroup(g.name) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh"));
    return NextResponse.json({ groups, total: groups.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "读取群列表失败" },
      { status: 500 }
    );
  }
}
