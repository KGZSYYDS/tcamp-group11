/**
 * WeFlow 调用封装。
 *
 * WeFlow（https://github.com/334456777/WeFlow）是本机已安装的微信导出工具，
 * 用用户自己的账号密钥读本机数据库，命令行导出 JSON。它做的是「导出自己的聊天记录」，
 * 不注入客户端、不读进程内存，所以不需要每台机器重新逆向。
 *
 * 本模块只做三件事：找到 exe、跑命令、解析 --json 输出。不含任何密钥处理：
 * 密钥由 WeFlow 自己存在 D:\Tools\WeFlow\data 下，本项目不读、不复制、不入库。
 *
 * 环境变量 WEFLOW_EXE 可覆盖路径；默认按常见位置探测。
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const CANDIDATES = [
  process.env.WEFLOW_EXE,
  "D:/Tools/WeFlow/weflow.cmd",
  "D:/Tools/WeFlow/weflow-v5.0.1-windows-x64/weflow.exe",
  path.join(process.cwd(), "tools/weflow/weflow.exe"),
].filter(Boolean);

export function findWeFlow() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) {
      // .cmd 需要 cmd 解释器；优先找同目录的 exe
      if (p.toLowerCase().endsWith(".cmd") || p.toLowerCase().endsWith(".bat")) {
        const dir = path.dirname(p);
        const exe = path.join(dir, "weflow-v5.0.1-windows-x64", "weflow.exe");
        if (fs.existsSync(exe)) return exe;
      }
      return p;
    }
  }
  return null;
}

function envFor(exe) {
  // weflow.cmd 通过 WEFLOW_HOME 固定配置目录；直接用 exe 时要自己补上，
  // 否则会去默认位置找配置，读不到已保存的密钥。
  const env = { ...process.env };
  if (!env.WEFLOW_HOME) {
    const guess = path.join(path.dirname(exe), "..", "data");
    if (fs.existsSync(guess)) env.WEFLOW_HOME = path.resolve(guess);
  }
  return env;
}

/** 跑一次 weflow，返回 { code, out, json } */
export function runWeFlow(exe, args, { timeout = 180000, json = true } = {}) {
  const r = spawnSync(exe, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: envFor(exe),
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) throw new Error(`调用 WeFlow 失败：${r.error.message}`);
  const out = (r.stdout || "").trim();
  if (r.status !== 0) {
    throw new Error(`WeFlow 返回 ${r.status}：${(r.stderr || out).slice(0, 300)}`);
  }
  let parsed = null;
  if (json && out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      // 部分子命令输出的是表格文本，不是 JSON
    }
  }
  if (parsed && parsed.success === false) {
    throw new Error(`WeFlow 报错：${parsed.error || JSON.stringify(parsed).slice(0, 200)}`);
  }
  return { code: r.status, out, json: parsed };
}

/** 检查可用性：版本 + 数据库连通 */
export function checkWeFlow(exe) {
  const ver = runWeFlow(exe, ["--version"], { json: false }).out;
  const test = runWeFlow(exe, ["--json", "db", "test"]).json;
  return {
    version: ver,
    connected: Boolean(test?.data?.connected),
    accountDir: test?.data?.accountDir || null,
  };
}

/** 联系人/会话列表：[{ username, displayName, type }] */
export function listContacts(exe) {
  const r = runWeFlow(exe, ["--json", "chat", "contacts", "--parsed"]);
  const raw = r.json;
  const arr = Array.isArray(raw) ? raw : raw?.data;
  if (!Array.isArray(arr)) throw new Error("WeFlow 返回的联系人列表格式不对");
  return arr.map((x) => ({
    username: x.username,
    displayName: x.displayName || x.nickname || x.username,
    type: x.type, // group | friend
  }));
}

/** 导出单个会话的消息，返回消息数组 */
export function exportMessages(exe, sessionId, outDir, { start, end, media } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = ["--json", "export", "messages", sessionId, "--out", outDir, "--format", "json"];
  if (start) args.push("--start", start);
  if (end) args.push("--end", end);
  if (media) args.push("--media", media);

  const r = runWeFlow(exe, args, { timeout: 300000 });
  const info = r.json?.data;
  if (!info?.out) throw new Error("WeFlow 没有报告导出路径");
  if (!fs.existsSync(info.out)) throw new Error(`导出文件不存在：${info.out}`);
  const payload = JSON.parse(fs.readFileSync(info.out, "utf-8"));
  return {
    file: info.out,
    count: info.count ?? (payload.messages || []).length,
    messages: payload.messages || [],
  };
}
