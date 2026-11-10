export const BOARD_TOPICS = Object.freeze({
  ENUM1: "教学与考试",
  ENUM2: "学生事务",
  ENUM3: "活动与学术",
  ENUM4: "发展机会",
  ENUM5: "校园服务",
  ENUM6: "行政与资讯",
});

// 现有云表没有主题字段。只在 note 首行保存机器标记，读取时再和原备注分离。
const MARKER = /^\[board-topic-v1:(ENUM[1-6])\](?:\r?\n|$)/;

export function readBoardNote(note) {
  const match = note?.match(MARKER);
  if (!match) return { topic: undefined, note };
  return { topic: BOARD_TOPICS[match[1]], note: note.slice(match[0].length) || undefined };
}

export function tagBoardNote(note, type) {
  if (!Object.hasOwn(BOARD_TOPICS, type)) throw new Error("无效的校园分类");
  const original = readBoardNote(note ?? undefined).note;
  return `[board-topic-v1:${type}]${original ? "\n" + original : ""}`;
}
