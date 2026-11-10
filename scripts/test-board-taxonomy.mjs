import assert from "node:assert/strict";
import { BOARD_GROUPS, boardGroup, boardNoticeId, inferBoardSubtype, mergeBoardListing, readBoardMetadata, writeBoardMetadata } from "../lib/board-taxonomy.mjs";
import { enrichBoardSubtypes, parseSubtypes, recentBoardEntries, subtypePrompt } from "./lib/board-subtypes.mjs";

assert.equal(BOARD_GROUPS.length, 6);
assert.equal(BOARD_GROUPS.flatMap((g) => Object.keys(g.subtypes)).length, 37);
const pin = mergeBoardListing(undefined, { id: "42", category: "置顶" }, "置顶");
const teaching = mergeBoardListing(pin, { id: "42", category: "教务" }, "教务");
const duplicate = mergeBoardListing(teaching, { id: "42", category: "科研" }, "科研");
assert.equal(pin.boardGroup, undefined);
assert.equal(duplicate.boardGroup, "teaching");
assert.equal(duplicate.pinned, true);
assert.deepEqual(duplicate.boardGroups, ["teaching", "research"]);
assert.equal(readBoardMetadata("栏目：教务｜原通知").group.label, "教务教学");
assert.equal(readBoardMetadata(writeBoardMetadata("原文", "lectures")).classified, false);
assert.equal(readBoardMetadata(writeBoardMetadata("原文", "lectures", null)).classified, true);
assert.equal(readBoardMetadata(writeBoardMetadata("原文", "lectures", "academic_report")).note, "原文");

const group = boardGroup("lectures");
assert.equal(boardNoticeId("http://www1.szu.edu.cn/board/view.asp?id=42#ddl"), "42");
assert.equal(boardNoticeId("https://example.org/board/view.asp?id=42"), undefined);
assert.equal(inferBoardSubtype(group, "深圳大学学术报告第十期"), "academic_report");
assert.equal(inferBoardSubtype(group, "学术论坛暨专题研讨会"), undefined);
assert.equal(inferBoardSubtype(group, "关于组织选课的通知"), undefined);
const valid = '{"items":[{"id":"1","subtype":"academic_report"},{"id":"2","subtype":null}]}';
assert.deepEqual([...parseSubtypes(valid, ["1", "2"], group)], [["1", "academic_report"], ["2", null]]);
for (const wrong of [
  valid.replace("academic_report", "course_selection"),
  valid.replace('"2"', '"1"'),
  valid.replace('"2"', '"9"'),
  valid.replace('"subtype":null', '"subtype":null,"extra":true'),
]) assert.throws(() => parseSubtypes(wrong, ["1", "2"], group));
assert(!subtypePrompt(group).includes("course_selection"));

const url = (id) => `https://www1.szu.edu.cn/board/view.asp?id=${id}`;
const records = [
  { title: "学术报告通知", category: "讲座", publishedAt: "2026-09-10", url: url(1) },
  { title: "选课通知", category: "教务", publishedAt: "2026-10-01", url: url(2) },
  { title: "旧通知", category: "教务", publishedAt: "2026-09-09", url: url(3) },
];
const rows = [
  { source_url: url(1), note: writeBoardMetadata("保留原文", "lectures") },
  { source_url: url(1) + "#s2", note: null },
  { source_url: url(2) + "#ddl", note: null },
  { source_url: url(3), note: null },
];
const today = "2026-11-10";
assert.equal(recentBoardEntries(records, today).length, 2);
const deps = {
  today,
  findRows: async (urls) => rows.filter((r) => urls.includes(r.source_url.split("#")[0])),
  updateNote: async (row, note) => { row.note = note; return true; },
  request: async ({ id }, batch) => {
    assert.equal(batch.length, 1);
    return JSON.stringify({ items: [{ id: batch[0].id, subtype: id === "lectures" ? "academic_report" : "course_selection" }] });
  },
};
const before = JSON.stringify(rows);
const unavailable = await enrichBoardSubtypes(records, { ...deps, request: async () => { throw new Error("离线"); } });
assert.equal(unavailable.failed, 2);
assert.equal(JSON.stringify(rows), before);
assert.equal((await enrichBoardSubtypes(records, deps)).saved, 3);
assert.equal(readBoardMetadata(rows[0].note).note, "保留原文");
assert.equal(readBoardMetadata(rows[1].note).subtype, "academic_report");
assert.equal(readBoardMetadata(rows[2].note).subtype, "course_selection");
assert.equal(rows[3].note, null);
assert.equal((await enrichBoardSubtypes(records, deps)).modelCalls, 0);

const reviewRecord = {
  ...records[0],
  content: "此次活动将围绕跨学科研究开展专题研讨，欢迎师生参加。",
};
const reviewRow = { source_url: url(1), note: null };
const reviewInputs = [];
const review = await enrichBoardSubtypes([reviewRecord], {
  ...deps,
  allowExcerpt: true,
  findRows: async () => [reviewRow],
  request: async (_group, batch) => {
    reviewInputs.push(batch[0]);
    return JSON.stringify({ items: [{ id: batch[0].id, subtype: batch[0].excerpt ? "seminar" : null }] });
  },
});
assert.deepEqual(reviewInputs, [
  { id: "1", title: reviewRecord.title },
  { id: "1", title: reviewRecord.title, excerpt: reviewRecord.content },
]);
assert.equal(review.modelCalls, 2);
assert.equal(readBoardMetadata(reviewRow.note).subtype, "seminar");
console.log("通过：六大类 37 小类、置顶去重、分栏白名单、两个月范围、失败不改原通知、多时段共享分类、空小类可选复判");
