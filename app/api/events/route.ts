import { NextResponse } from "next/server";
import { createEvent, listEvents } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: listEvents() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.title || !body.startAt) {
      return NextResponse.json(
        { error: "title、startAt 为必填字段" },
        { status: 400 }
      );
    }
    if (Number.isNaN(Date.parse(body.startAt))) {
      return NextResponse.json({ error: "startAt 时间格式无效" }, { status: 400 });
    }
    const event = createEvent(body);
    return NextResponse.json({ item: event }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
}
