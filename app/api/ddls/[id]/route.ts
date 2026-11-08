import { NextResponse } from "next/server";
import { deleteDdl, updateDdl } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(request: Request, { params }: Params) {
  const body = await request.json();
  const patch: Record<string, unknown> = {};
  if (body.status === "pending" || body.status === "done") {
    patch.status = body.status;
  }
  if (typeof body.note === "string") patch.note = body.note;
  if (typeof body.dueAt === "string" && !Number.isNaN(Date.parse(body.dueAt))) {
    patch.dueAt = new Date(body.dueAt).toISOString();
  }
  const updated = updateDdl(params.id, patch);
  if (!updated) return NextResponse.json({ error: "未找到该条目" }, { status: 404 });
  return NextResponse.json({ item: updated });
}

export async function DELETE(_request: Request, { params }: Params) {
  const ok = deleteDdl(params.id);
  if (!ok) return NextResponse.json({ error: "未找到该条目" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
