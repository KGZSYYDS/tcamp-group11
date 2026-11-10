import { NextResponse } from "next/server";
import { createEvent, eventExistsBySourceUrl } from "@/lib/data";
import { extractLocation } from "@/lib/location.mjs";
import { boardGroup, writeBoardMetadata } from "@/lib/board-taxonomy.mjs";
import type { EventKind } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * 公文通采集结果入库（公共数据层）。
 *
 * 注意：当前实际链路不用这个接口 —— `scripts/ingest-notices.mjs` 直接写数据面 REST，
 * 一次能出「活动行 + 截止行」两行，能力比这里强。保留本路由只为对外投递口兼容，
 * 新功能请加在脚本侧，别在这里堆。
 *
 * scripts/collect-board.mjs 产出 notices-*.json，登录状态下 POST 到这里：
 *   curl -X POST http://localhost:3000/api/board/ingest \
 *        -H "Content-Type: application/json" \
 *        -d @data/board/notices-20261108.json
 *
 * 规则：
 * - 以 source_url 去重，同一条通知不重复入库
 * - scope 固定 school（全校可见，非深大用户也能看到）
 * - 按标题关键词粗分类，避免每条都调 LLM；分类不确定的落 other
 */

const KIND_RULES: Array<[EventKind, RegExp]> = [
  ["pe", /体测|体质测试|体测周|军训|体检|体能/],
  ["exam", /考试|期末|期中|补考|重修|四六级|CET|测验|监考|成绩复核/],
  [
    "activity",
    /讲座|论坛|沙龙|研讨会|报告会|开放日|展览|演出|比赛|竞赛|大赛|招募|报名|宣讲|招聘|双选会|创新领航|文体|社团/,
  ],
];

function classify(title: string): EventKind {
  for (const [kind, re] of KIND_RULES) {
    if (re.test(title)) return kind;
  }
  return "other";
}

/** 通知的 publishedAt 只有日期，按整日事件处理（北京时间零点） */
function toStartAt(date: string | null | undefined): string {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  return `${d}T00:00:00+08:00`;
}

interface BoardItem {
  url: string;
  title: string;
  department?: string | null;
  publishedAt?: string | null;
  content?: string;
  category?: string;
  boardGroup?: string;
}

export async function POST(request: Request) {
  let body: { items?: BoardItem[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : Array.isArray(body) ? body : null;
  if (!items) {
    return NextResponse.json({ error: "需要 items 数组" }, { status: 400 });
  }

  let added = 0;
  let skipped = 0;
  const failed: Array<{ url: string; error: string }> = [];

  for (const item of items) {
    if (!item || !item.url || !item.title) {
      skipped++;
      continue;
    }
    try {
      if (await eventExistsBySourceUrl(item.url)) {
        skipped++;
        continue;
      }
      const group = boardGroup(item.boardGroup) || boardGroup(item.category);
      const note = [item.department, item.content?.slice(0, 300)].filter(Boolean).join("｜") || undefined;
      await createEvent({
        kind: classify(item.title),
        title: item.title.slice(0, 120),
        startAt: toStartAt(item.publishedAt),
        allDay: true,
        link: item.url,
        note: group ? writeBoardMetadata(note, group.id) : note,
        location: extractLocation(item.content || "").location ?? undefined,
        scope: "school",
        source: "board",
        sourceUrl: item.url,
      });
      added++;
    } catch (e) {
      failed.push({ url: item.url, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ added, skipped, failed: failed.length, errors: failed.slice(0, 10) });
}
