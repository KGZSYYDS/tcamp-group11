import { NextResponse } from "next/server";
import { fetchTodos, loadSession } from "@/lib/szu-lms";
import { guardLocalOnly } from "@/lib/local-only";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 拉畅课的作业待办。
 *
 * 返回的是给前端写 localStorage 用的 DdlInput 形态，字段名和
 * lib/local-store 的 importDdls 对齐（course / title / dueAt / note / url）。
 * 服务端不落库 —— 作业属于本机数据，写完就丢。
 */
export async function GET() {
  // 畅课会话是服务端单文件缓存的，公网多人共用会串号
  const denied = guardLocalOnly("畅课同步");
  if (denied) return denied;

  const jar = loadSession();
  if (!jar) {
    return NextResponse.json({ error: "还没登录畅课", needsLogin: true }, { status: 401 });
  }

  try {
    const { todos, expired } = await fetchTodos(jar);
    if (expired) {
      return NextResponse.json({ error: "畅课会话已过期，重新登录一次", needsLogin: true }, { status: 401 });
    }
    return NextResponse.json({
      items: todos.map((t) => ({
        course: t.course,
        title: t.title,
        dueAt: t.dueAt,
        url: t.url,
        note: t.note,
        source: "lms-sync",
      })),
      total: todos.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "读取畅课作业失败" },
      { status: 500 }
    );
  }
}
