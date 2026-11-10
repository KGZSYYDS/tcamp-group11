import fs from "node:fs";
import path from "node:path";
import { enrichBoardSubtypes, createSubtypeRequest, recentBoardEntries, shanghaiDate } from "./lib/board-subtypes.mjs";

const input = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "data/board/notices-latest.json";
const lockPath = path.resolve("data/board/.ai-classification.lock");

async function main() {
  const records = JSON.parse(fs.readFileSync(input, "utf8"));
  if (!Array.isArray(records)) throw new Error("通知快照必须是数组");
  const today = shanghaiDate();
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ today, eligible: recentBoardEntries(records, today).length }));
    return;
  }
  const base = process.env.BOARD_AI_BASE_URL;
  const key = process.env.BOARD_AI_API_KEY;
  const model = process.env.BOARD_AI_MODEL || "deepseek-flash";
  if (!base || !key) throw new Error("缺少 BOARD_AI_BASE_URL 或 BOARD_AI_API_KEY");
  const request = createSubtypeRequest({ base, key, model, allowHttp: process.env.BOARD_AI_ALLOW_HTTP === "1" });

  const config = fs.readFileSync(new URL("../lib/cloud.ts", import.meta.url), "utf8");
  const field = (name) => config.match(new RegExp(`\\b${name}\\s*:\\s*["']([^"']+)["']`))?.[1];
  const endpoint = field("endpoint");
  const publicKey = field("publishableKey");
  if (!endpoint || !publicKey) throw new Error("缺少项目云表配置");
  const table = new URL("/.cloud/database/rest/events", endpoint);
  const headers = { "x-wb-webapp-access-key": publicKey, "Content-Type": "application/json" };

  async function findRows(urls) {
    const query = new URL(table);
    query.searchParams.set("select", "id,source_url,note");
    query.searchParams.set("source", "eq.board");
    const exact = urls.flatMap((url) => [url, url + "#ddl"]).map((url) => JSON.stringify(url));
    const spans = urls.map((url) => `source_url.like.${JSON.stringify(url + "#s*")}`);
    query.searchParams.set("or", `(source_url.in.(${exact.join(",")}),${spans.join(",")})`);
    const res = await fetch(query, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`读取校园事件失败（HTTP ${res.status}）`);
    return res.json();
  }

  async function updateNote(row, note) {
    const query = new URL(table);
    query.searchParams.set("id", `eq.${row.id}`);
    query.searchParams.set("source", "eq.board");
    // 并发编辑时不覆盖用户或其他入库任务写入的新备注。
    query.searchParams.set("note", row.note == null ? "is.null" : `eq.${row.note}`);
    const res = await fetch(query, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({ note }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`保存分类失败（HTTP ${res.status}）`);
    return (await res.json()).length > 0;
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("已有公文通分类任务，跳过本轮");
    return;
  }
  try {
    const result = await enrichBoardSubtypes(records, {
      request, findRows, updateNote, today, allowExcerpt: process.env.BOARD_AI_REVIEW_EXCERPT === "1",
    });
    console.log(JSON.stringify({ today, ...result }));
    if (result.failed) process.exitCode = 1;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

main().catch((error) => {
  console.error("公文通分类失败：", error.message);
  process.exitCode = 1;
});
