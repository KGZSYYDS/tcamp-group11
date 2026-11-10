import { readBoardNote, tagBoardNote } from "../../lib/board-topic.mjs";
import { classifyBatches, SYSTEM_PROMPT } from "./board-ai-batch.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_TITLE = /退学|处分|惩戒|讣告|名单|隐私|拟录取|候选人|身份证|学号|请假|报销|心理咨询|内部|仅限|未公开/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(date);
}

export function boardWindowStart(today) {
  const [year, month, day] = today.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 3, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

export function recentBoardNotices(items, today = shanghaiDate()) {
  const since = boardWindowStart(today);
  const unique = new Map();
  for (const item of items) {
    const { publishedAt, title, url } = item;
    if (!DATE.test(publishedAt || "") || publishedAt < since || publishedAt > today ||
        typeof title !== "string" || !title.trim() || SENSITIVE_TITLE.test(title) || typeof url !== "string") continue;
    let sourceUrl;
    try { sourceUrl = new URL(url); } catch { continue; }
    if (sourceUrl.hostname !== "www1.szu.edu.cn" || !sourceUrl.pathname.toLowerCase().startsWith("/board/")) continue;
    if (!unique.has(url)) unique.set(url, { url, title, publishedAt });
  }
  return [...unique.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function enrichBoardNotices(items, { findRows, updateNote, request, model, today }) {
  const notices = recentBoardNotices(items, today);
  const candidates = [];
  for (let i = 0; i < notices.length; i += 16) {
    const group = notices.slice(i, i + 16);
    const rows = await findRows(group.map(({ url }) => url));
    const byUrl = new Map();
    for (const row of rows) {
      const source = row.source_url.replace(/#(?:ddl|s\d+)$/, "");
      const list = byUrl.get(source) || [];
      list.push(row);
      byUrl.set(source, list);
    }
    for (const notice of group) {
      const existing = byUrl.get(notice.url) || [];
      const untagged = existing.filter((row) => !readBoardNote(row.note ?? undefined).topic);
      if (untagged.length) {
        candidates.push({ id: String(candidates.length + 1), title: notice.title, rows: untagged });
      }
    }
  }

  const result = await classifyBatches(candidates, { request, model, batchSize: 12, concurrency: 2 });
  const byId = new Map(candidates.map((item) => [item.id, item]));
  let updated = 0;
  let updateFailures = 0;
  for (const { id, type } of result.items) {
    for (const row of byId.get(id).rows) {
      try {
        if (await updateNote(row, tagBoardNote(row.note, type))) updated++;
      } catch {
        updateFailures++;
      }
    }
  }
  return {
    eligible: notices.length,
    pending: candidates.length,
    classified: result.items.length,
    requests: result.requests,
    updated,
    updateFailures,
    modelFailures: result.failures.length,
  };
}

export function makeBoardModelRequest({ base, key, model, allowHttp = false }) {
  const endpoint = new URL(base.replace(/\/$/, "") + "/chat/completions");
  if (endpoint.protocol !== "https:" && !(allowHttp && endpoint.protocol === "http:")) {
    throw new Error("AI 地址需要 HTTPS；仅测试可显式启用 HTTP");
  }
  let nextStart = 0;
  return async (batch, signal) => {
    while (performance.now() < nextStart) {
      await sleep(nextStart - performance.now());
      signal.throwIfAborted();
    }
    nextStart = performance.now() + 1000;
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 1100, thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ items: batch }) },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const wait = header && /^\d+$/.test(header)
          ? Number(header) * 1000
          : header ? Date.parse(header) - Date.now() : NaN;
        nextStart = Math.max(nextStart, performance.now() + (Number.isFinite(wait) ? Math.max(1000, wait) : 4000));
      }
      const error = new Error("模型请求失败");
      error.name = `HTTP${response.status}`;
      throw error;
    }
    return (await response.json()).choices?.[0]?.message?.content;
  };
}
