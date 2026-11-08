import { cloud } from "./cloud";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ParsedEvent {
  title: string;
  kind: "exam" | "pe" | "activity" | "other";
  date: string | null;
  /** 时间段事件的结束日期（如体测周），单日为 null */
  endDate: string | null;
  time: string | null;
  location: string | null;
  /** 预约 / 报名 / 详情链接 */
  link: string | null;
  scope: "school" | "college" | "grade" | "undergraduate" | "postgraduate" | "doctoral";
  college: string | null;
  grade: string | null;
}

/** 宽松日期归一化：接受 2026-11-8 / 2026/11/08 / 2026年11月8日 等格式 */
function normalizeDate(value: unknown): string | null {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
  if (!m) return null;
  const y = m[1];
  const mm = m[2].padStart(2, "0");
  const dd = m[3].padStart(2, "0");
  const dt = new Date(`${y}-${mm}-${dd}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : `${y}-${mm}-${dd}`;
}

/** 正则提取正文中的日期候选（公文通日期格式规整，命中率高） */
function extractDateCandidates(content: string): string[] {
  const out = new Set<string>();
  const re =
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g;
  let m;
  while ((m = re.exec(content))) {
    const iso = normalizeDate(
      `${m[1] || m[4]}-${m[2] || m[5]}-${m[3] || m[6]}`
    );
    if (iso) out.add(iso);
    if (out.size >= 10) break;
  }
  return Array.from(out);
}

/** 把校园通知（标题+正文）解析为结构化日历事件 */
export async function parseNoticeToEvent(
  title: string,
  content: string
): Promise<ParsedEvent> {
  const models = await cloud.llm.models.list();
  const model = models.find((m: any) => m.disabled !== true);
  if (!model) throw new Error("当前没有可用的 AI 模型，请稍后再试");

  const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const candidates = extractDateCandidates(content);
  const candidateHint =
    candidates.length > 0
      ? `\n正则从正文提取到的日期候选：${candidates.join("、")}。请从中选择与该通知事件对应的日期。`
      : "";

  const systemPrompt = `你是校园通知解析器。从通知文本中提取一个日历事件，只输出 JSON，不要输出任何其他文字。JSON 字段：
{"title": "事件简短标题(不超过30字)", "kind": "exam 或 pe 或 activity 或 other（分别对应考试/体测/活动/其他）", "date": "YYYY-MM-DD 开始日期，必填，必须尽力从正文推断", "endDate": "YYYY-MM-DD 结束日期；时间段事件（如体测周、活动周）填写，单日事件为 null", "time": "HH:mm，无具体时间则为 null（需自行预约时段的活动一律为 null）", "location": "地点，无则为 null", "link": "通知中的预约/报名/详情链接(http开头)，无则为 null", "scope": "school 或 college 或 grade 或 undergraduate 或 postgraduate 或 doctoral（面向对象：全校/某学院/某年级/本科生/硕士生/博士生，无法判断用 school）", "college": "scope 为 college 时的学院全名，否则 null", "grade": "scope 为 grade 时的年级如 2026 级，否则 null"}
规则：
- date 为必填项，不得轻易给 null；正文中的"报名时间""活动时间""截止时间"都可作为依据，只有全文确实没有任何日期信息时才允许 null。
- 正文可能混有导航栏、其他通知标题等噪音，只关注与标题对应的那条通知的内容。
- 不得编造通知中没有的信息；有多个时间时选最主要的活动时间；需要预约的活动 date 填预约或活动的开始日期，endDate 填结束日期。
- 日期可能是中文格式或缺少年份（缺年份用今年）。今天是${today}，相对日期据此换算。
- scope 选择层次时的判断依据：答辩、学位论文、开题、中期检查、研究生招生等通知通常面向研究生（postgraduate 硕士或 doctoral 博士）；体测、军训、新生入学、本科课程相关通知通常面向本科生（undergraduate）。${candidateHint}`;

  let answer = "";
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `通知标题：${title}\n\n通知正文：\n${content.slice(0, 4000)}`,
      },
    ],
    stream: true,
    response_format: { type: "json_object" },
  }) as any) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) answer += delta;
  }

  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 返回格式异常，请重试");
  const parsed = JSON.parse(match[0]);

  // AI 未给出日期时，用正则候选兜底（用户仍可编辑确认）
  const aiDate = normalizeDate(parsed.date);
  const date = aiDate || candidates[0] || null;

  return {
    title: String(parsed.title || title).slice(0, 60),
    kind: ["exam", "pe", "activity", "other"].includes(parsed.kind)
      ? parsed.kind
      : "other",
    date,
    endDate: normalizeDate(parsed.endDate),
    time: /^\d{2}:\d{2}$/.test(parsed.time || "") ? parsed.time : null,
    location: parsed.location || null,
    link: typeof parsed.link === "string" && parsed.link.startsWith("http") ? parsed.link : null,
    scope: ["school", "college", "grade", "undergraduate", "postgraduate", "doctoral"].includes(parsed.scope)
      ? parsed.scope
      : "school",
    college: parsed.college || null,
    grade: parsed.grade || null,
  };
}

// ---------- 粘贴文本解析（无插件用户的作业导入） ----------

export interface DdlCandidate {
  course: string;
  title: string;
  date: string | null;
  time: string | null;
}

/** 从畅课待办页等粘贴文本中批量提取作业 */
export async function parseDdlText(text: string): Promise<DdlCandidate[]> {
  const models = await cloud.llm.models.list();
  const model = models.find((m: any) => m.disabled !== true);
  if (!model) throw new Error("当前没有可用的 AI 模型，请稍后再试");

  const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const systemPrompt = `你是作业列表提取器。用户粘贴了教学平台待办页面的文字，从中提取所有作业条目，只输出 JSON 数组，不要输出任何其他文字。数组元素格式：
{"course": "课程名（无法识别则用 未匹配课程）", "title": "作业标题", "dueDate": "YYYY-MM-DD 截止日期，无法确定则为 null", "dueTime": "HH:mm 截止时间，无则为 null"}
规则：
- 忽略页面导航、按钮、状态标签（如 未提交/已提交/待批改）、成绩、页码等无关文字，只提取作业条目。
- 截止时间格式多样（如 11月8日 23:59、2026-11-08、明天 23:59、周五截止），今天是${today}，相对日期据此换算。
- 不得编造作业；不确定的条目宁可不提取，也不要虚构课程或日期。`;

  let answer = "";
  for await (const chunk of cloud.llm.chat.completions.create({
    model: model.id,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text.slice(0, 6000) },
    ],
    stream: true,
    response_format: { type: "json_object" },
  }) as any) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) answer += delta;
  }

  const match = answer.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("AI 未能识别出作业列表，请检查粘贴内容");
  const arr = JSON.parse(match[0]);
  if (!Array.isArray(arr)) throw new Error("AI 返回格式异常");

  return arr
    .filter((d: any) => d && d.title)
    .map((d: any) => ({
      course: String(d.course || "未匹配课程").slice(0, 40),
      title: String(d.title).slice(0, 120),
      date: normalizeDate(d.dueDate),
      time: /^\d{2}:\d{2}$/.test(d.dueTime || "") ? d.dueTime : null,
    }));
}

