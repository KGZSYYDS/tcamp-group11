import fs from "node:fs";
import { NextResponse } from "next/server";
import { dedupeItems, extractFromChats } from "@/lib/chat-extract";
import { cleanup, exportGroup, findWeFlow, weflowStatus } from "@/lib/wechat-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 扫描本机微信里选中的群 → 返回提取出来的事项。
 *
 * 这条链路替代了「让用户自己去微信里多选复制」：导出、清洗、抽取全在
 * 服务端（也就是用户这台电脑）完成，前端只负责把结果写进 localStorage。
 *
 * 原始消息不返回、不落库：导出文件写在系统临时目录，扫完立即删。
 */
const MAX_GROUPS = 12;
const MAX_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

interface GroupArg {
  id?: unknown;
  name?: unknown;
}

export async function POST(request: Request) {
  const s = weflowStatus();
  if (!s.available || !s.connected) {
    return NextResponse.json(
      { error: s.error || "微信数据库没连上，先在微信里正常登录一次再试" },
      { status: 503 }
    );
  }
  const exe = findWeFlow();
  if (!exe) return NextResponse.json({ error: "找不到 WeFlow" }, { status: 503 });

  let body: { groups?: unknown; days?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const rawGroups = Array.isArray(body.groups) ? (body.groups as GroupArg[]) : [];
  const groups = rawGroups
    .map((g) => ({ id: String(g?.id || ""), name: String(g?.name || "") }))
    .filter((g) => g.id && g.name);

  if (!groups.length) return NextResponse.json({ error: "至少选一个群" }, { status: 400 });
  if (groups.length > MAX_GROUPS) {
    return NextResponse.json({ error: `一次最多扫 ${MAX_GROUPS} 个群` }, { status: 400 });
  }

  const days = Math.min(MAX_DAYS, Math.max(1, Number(body.days) || 7));
  const today = new Date();
  const start = isoDate(addDays(today, -days));
  const end = isoDate(today);

  const items: ReturnType<typeof dedupeItems> = [];
  const stats: {
    name: string;
    messages: number;
    hinted: number;
    items: number;
    error?: string;
  }[] = [];
  const dirs: string[] = [];

  try {
    for (const g of groups) {
      try {
        const exp = exportGroup(exe, g.id, start, end);
        dirs.push(exp.dir);
        const text = fs.readFileSync(exp.file, "utf-8");
        // name 传群名：抽取结果里的「来自群：X」直接用它，不用再改文件名
        const r = extractFromChats([{ name: g.name, text, lastModified: Date.now() }]);
        items.push(...r.items);
        stats.push({ name: g.name, messages: r.scanned, hinted: r.hinted, items: r.items.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "导出失败";
        // 空群很常见（区间内没消息），不把它渲染成红色报错
        const empty = /no messages|没有消息|not found/i.test(msg);
        stats.push({ name: g.name, messages: 0, hinted: 0, items: 0, error: empty ? "这段时间没消息" : msg });
      }
    }
  } finally {
    cleanup(dirs);
  }

  const deduped = dedupeItems(items);
  const scanned = stats.reduce((n, x) => n + x.messages, 0);
  const hinted = stats.reduce((n, x) => n + x.hinted, 0);

  return NextResponse.json(
    { items: deduped, stats, range: { start, end, days }, scanned, hinted },
    { headers: { "Cache-Control": "no-store" } }
  );
}
