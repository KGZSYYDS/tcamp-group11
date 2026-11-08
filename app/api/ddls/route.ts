import { NextResponse } from "next/server";
import { createDdl, listDdls } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: listDdls() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.course || !body.title || !body.dueAt) {
      return NextResponse.json(
        { error: "course、title、dueAt 为必填字段" },
        { status: 400 }
      );
    }
    if (Number.isNaN(Date.parse(body.dueAt))) {
      return NextResponse.json({ error: "dueAt 时间格式无效" }, { status: 400 });
    }
    const ddl = createDdl(body);
    return NextResponse.json({ item: ddl }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
}
