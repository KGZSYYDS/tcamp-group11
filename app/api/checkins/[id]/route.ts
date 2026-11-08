import { NextResponse } from "next/server";
import { deleteCheckin } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function DELETE(_request: Request, { params }: Params) {
  const ok = deleteCheckin(params.id);
  if (!ok) return NextResponse.json({ error: "未找到该签到记录" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
