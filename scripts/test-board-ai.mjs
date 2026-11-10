import assert from "node:assert/strict";
import { readBoardNote, tagBoardNote } from "../lib/board-topic.mjs";
import { boardWindowStart, enrichBoardNotices, recentBoardNotices } from "./lib/board-ai-job.mjs";
import { parseReply } from "./lib/board-ai-batch.mjs";

const date = "2026-11-10";
const url = (id) => `https://www1.szu.edu.cn/board/view.asp?id=${id}`;
const notice = (id, publishedAt, title = "校园讲座") => ({ url: url(id), publishedAt, title, content: "正文不会发送" });
const original = "栏目：教务｜原备注";
const notices = [
  notice(1, "2026-09-10"), notice(1, "2026-09-10"),
  notice(2, "2026-09-09"), notice(3, "2025-11-10"), notice(4, "2026-11-11"),
  notice(5, "2026-10-20", "拟退学名单"), notice(6, "2026-11-01"), notice(7, "2026-11-02"),
];
assert.equal(boardWindowStart(date), "2026-09-10");
assert.equal(boardWindowStart("2027-01-31"), "2026-11-30");
assert.deepEqual(recentBoardNotices(notices, date).map((r) => r.url), [url(7), url(6), url(1)]);
assert.deepEqual(readBoardNote(original), { topic: undefined, note: original });
assert.deepEqual(readBoardNote(tagBoardNote(original, "ENUM3")), { topic: "活动与学术", note: original });
assert.deepEqual(readBoardNote(tagBoardNote(tagBoardNote(original, "ENUM3"), "ENUM5")), { topic: "校园服务", note: original });
assert.throws(() => parseReply('{"items":[{"id":"0","type":"ENUM7"}]}', [{ id: "0" }]));

const rows = [
  { id: "one", source_url: url(1), note: original },
  { id: "deadline", source_url: url(1) + "#ddl", note: "截止备注" },
  { id: "old", source_url: url(3), note: "历史通知" },
  { id: "classified", source_url: url(6), note: tagBoardNote("已处理", "ENUM1") },
  { id: "span", source_url: url(1) + "#s2", note: "第二个时段" },
];
let requestCount = 0;
const deps = {
  today: date, model: "mock",
  async findRows(urls) {
    assert(!urls.includes(url(3)));
    return rows.filter((row) => urls.includes(row.source_url.replace(/#(?:ddl|s\d+)$/, ""))).map((row) => ({ ...row }));
  },
  async updateNote(row, note) {
    const originalRow = rows.find((r) => r.id === row.id);
    assert.equal(row.note, originalRow.note);
    originalRow.note = note;
    return true;
  },
  async request(batch) {
    requestCount++;
    assert.equal(batch.length, 1, "已有分类或还未入库的通知不会发送");
    assert.deepEqual(Object.keys(batch[0]).sort(), ["id", "title"]);
    return JSON.stringify({ items: [{ id: batch[0].id, type: "ENUM3" }] });
  },
};

const before = JSON.stringify(rows);
const failed = await enrichBoardNotices(notices, {
  ...deps,
  request: async () => { throw new Error("模拟 AI 不可用"); },
  updateNote: async () => { assert.fail("模型失败后不应写入"); },
});
assert.equal(failed.modelFailures, 1);
assert.equal(JSON.stringify(rows), before);

const result = await enrichBoardNotices(notices, deps);
assert.equal(result.classified, 1);
assert.equal(result.updated, 3, "同一篇的活动、截止和其他时段共用分类");
assert.deepEqual(readBoardNote(rows[0].note), { topic: "活动与学术", note: original });
assert.equal(readBoardNote(rows[1].note).topic, "活动与学术");
assert.equal(rows[2].note, "历史通知");
assert.equal(readBoardNote(rows[4].note).topic, "活动与学术");
assert.equal((await enrichBoardNotices(notices, deps)).requests, 0);
assert.equal(requestCount, 1);
console.log("通过：两个月窗口、旧通知保留、失败无修改、只传标题、同源行共享标签、重复运行不再调用 AI");
