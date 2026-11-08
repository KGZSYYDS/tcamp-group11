/**
 * 群聊 → 会议提取的离线验证脚本。
 *
 * 用途：改提示词（lib/meeting-prompt.mjs）后，先在这里跑一遍看效果，不用起前端。
 * 输入是本地文件，输出是解析出的会议列表；不写库、不碰任何聊天软件。
 *
 * 用法：
 *   node scripts/test-meetings.mjs data/tmp/chat-sample.txt
 *   node scripts/test-meetings.mjs --image data/tmp/chat-shot.png
 */
import fs from "fs";
import path from "path";
import { createWorkBuddyCloud } from "@tencent-ai/workbuddy-cloud-sdk";
import { meetingSystemPrompt, weekAnchors } from "../lib/meeting-prompt.mjs";

const ENDPOINT = "https://szu-calendar.app.workbuddy.host";
const KEY = "wbpk_WzXwYj6XGdnn7m7c2NTc2V_k6ZmPeTV5hMYlO7DXtHIUckhNgKMaVZy";

const cloud = createWorkBuddyCloud({
  endpoint: ENDPOINT,
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: KEY,
});

const argv = process.argv.slice(2);
const imgIdx = argv.indexOf("--image");
const IMAGE = imgIdx >= 0 ? argv[imgIdx + 1] : null;
const FILE = IMAGE ? IMAGE : argv[0];

function todayContext() {
  const a = weekAnchors();
  return { today: a.today, weekday: a.weekday };
}

async function main() {
  if (!FILE) throw new Error("用法：node scripts/test-meetings.mjs <聊天文本文件> | --image <截图>");
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);

  const models = await cloud.llm.models.list();
  const usable = models.filter((m) => m && m.disabled !== true && m.enabled !== false);
  const model = IMAGE
    ? usable.find((m) => m.supportsImages === true && m.disabledMultimodal !== true)
    : usable[0];
  if (!model) throw new Error(IMAGE ? "没有支持读图的模型" : "没有可用模型");
  console.log(`模型：${model.id}${model.supportsImages ? "（支持读图）" : ""}`);

  const ctx = todayContext();
  const anchors = weekAnchors();
  console.log(
    `今天 ${anchors.today}（${anchors.weekday}） 本周一 ${anchors.mondayThisWeek} 下周一 ${anchors.mondayNextWeek}`
  );
  const system = meetingSystemPrompt(anchors, Boolean(IMAGE));

  let userContent;
  if (IMAGE) {
    const mime = abs.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const b64 = fs.readFileSync(abs).toString("base64");
    userContent = [
      { type: "text", text: "这是一张聊天窗口截图，请提取其中的会议安排。" },
      { type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "high" } },
    ];
  } else {
    userContent = fs.readFileSync(abs, "utf-8").slice(0, 8000);
  }

  const t0 = Date.now();
  let answer = "";
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    stream: true,
    response_format: { type: "json_object" },
  })) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) answer += delta;
  }

  console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，原始输出：\n${answer}\n`);

  const match = answer.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("模型没有返回 JSON 数组");
  const arr = JSON.parse(match[0]);
  console.log(`解析到 ${arr.length} 场会议：`);
  for (const m of arr) {
    console.log(
      `  ${m.date || "(无日期)"} ${m.startTime || "--:--"}${m.endTime ? "~" + m.endTime : ""}  ${m.title}` +
        `${m.location ? "  @" + m.location : ""}  提醒${m.remindBefore}分钟前`
    );
    if (m.quote) console.log(`      原话：${m.quote}`);
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
