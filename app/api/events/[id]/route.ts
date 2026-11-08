import { NextResponse } from "next/server";
import { deleteEvent } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function DELETE(_request: Request, { params }: Params) {
  const ok = deleteEvent(params.id);
  if (!ok) return NextResponse.json({ error: "未找到该事件" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
