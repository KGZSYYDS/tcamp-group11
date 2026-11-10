import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  detectWeChatDirs,
  detectWeFlowCandidates,
  findWeFlow,
  invalidateStatus,
  readConfig,
  setWeChatDir,
  weflowStatus,
  writeConfig,
} from "@/lib/wechat-local";
import { guardLocalOnly } from "@/lib/local-only";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 陌生电脑上的「它到底装在哪」。
 *
 * GET  → 扫一遍磁盘，把找到的 WeFlow 候选和微信数据目录列出来
 * POST → 用户确认了某个路径，存进 data/.weflow-config.json
 *
 * 为什么要让用户确认：同一台机器上可能装着多个版本，自动挑一个用
 * 有可能挑到旧的。让用户看一眼「是不是这个」比默默用错的强。
 */
export async function GET() {
  // 这个接口会扫服务器磁盘并回吐路径，公网暴露等于给陌生人一份目录结构
  const denied = guardLocalOnly("微信通道探测");
  if (denied) return denied;

  const cfg = readConfig();
  const exe = findWeFlow();
  return NextResponse.json({
    candidates: detectWeFlowCandidates(),
    wechatDirs: detectWeChatDirs(exe),
    config: cfg,
  });
}

export async function POST(request: Request) {
  const denied = guardLocalOnly("微信通道配置");
  if (denied) return denied;

  let body: { exePath?: unknown; wechatDir?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const patch: { exePath?: string; wechatDir?: string } = {};

  if (typeof body.exePath === "string" && body.exePath.trim()) {
    const p = body.exePath.trim().replace(/^"|"$/g, "");
    if (!fs.existsSync(p)) {
      return NextResponse.json({ error: `这个路径不存在：${p}` }, { status: 400 });
    }
    if (!/weflow\.(exe|cmd|bat)$/i.test(p)) {
      return NextResponse.json(
        { error: "请选 weflow.exe 或 weflow.cmd（不是它所在的文件夹）" },
        { status: 400 }
      );
    }
    patch.exePath = path.resolve(p);
  }

  if (typeof body.wechatDir === "string" && body.wechatDir.trim()) {
    const d = body.wechatDir.trim().replace(/^"|"$/g, "");
    if (!fs.existsSync(d)) {
      return NextResponse.json({ error: `这个目录不存在：${d}` }, { status: 400 });
    }
    patch.wechatDir = path.resolve(d);
  }

  if (!patch.exePath && !patch.wechatDir) {
    return NextResponse.json({ error: "没有要保存的内容" }, { status: 400 });
  }

  // 指定微信目录时，必须真的验证一遍再写：直接塞进配置里，后面 db test
  // 只会报「打不开」，用户根本不知道是路径错了还是密钥过期。
  let applied: { accounts: number; wxid?: string } | null = null;
  if (patch.wechatDir) {
    const exe = patch.exePath || findWeFlow();
    if (!exe) {
      return NextResponse.json({ error: "还没找到 WeFlow，先解决工具这一层" }, { status: 400 });
    }
    const r = setWeChatDir(exe, patch.wechatDir);
    if (!r.ok) {
      return NextResponse.json({ error: r.message || "这个目录不能用" }, { status: 400 });
    }
    applied = { accounts: r.accounts, wxid: r.wxid };
    // 目录已经由 WeFlow 自己记下（config set db_path），不再重复存一份
    delete patch.wechatDir;
  }

  if (Object.keys(patch).length) {
    writeConfig(patch);
    invalidateStatus();
  }
  return NextResponse.json({ ok: true, applied, status: weflowStatus(true) });
}
