import { NextResponse } from "next/server";
import { createCheckin, listCheckins } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: listCheckins() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.course || !body.occurredAt) {
      return NextResponse.json(
        { error: "course、occurredAt 为必填字段" },
        { status: 400 }
      );
    }
    if (Number.isNaN(Date.parse(body.occurredAt))) {
      return NextResponse.json({ error: "occurredAt 时间格式无效" }, { status: 400 });
    }
    const checkin = createCheckin(body);
    return NextResponse.json({ item: checkin }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
}
