"use client";

import { useRef, useState } from "react";
import { createEvent } from "@/lib/data";
import { addMyEvent, importDdls } from "@/lib/local-store";
import {
  REMIND_OPTIONS,
  buildMeetingNote,
  parseChatImageToMeetings,
  parseChatToMeetings,
  parseDdlText,
  parseNoticeToEvent,
  type DdlCandidate,
  type MeetingCandidate,
  type ParsedEvent,
} from "@/lib/llm";

interface Candidate extends DdlCandidate {
  selected: boolean;
}

interface MeetingRow extends MeetingCandidate {
  selected: boolean;
}

export default function PasteImporter() {
  const [mode, setMode] = useState<"auto" | "ddl" | "event" | "chat">("auto");
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [resultMsg, setResultMsg] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [importing, setImporting] = useState(false);
  const [eventForm, setEventForm] = useState<ParsedEvent | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);
  // 群聊模式
  const [image, setImage] = useState<string>("");
  const [groupName, setGroupName] = useState("");
  const [meetings, setMeetings] = useState<MeetingRow[]>([]);
  const [savingMeetings, setSavingMeetings] = useState(false);

  /**
   * 最新的 text / image 镜像。
   *
   * 所有「setState 之后再解析」的地方都不能直接读 state：setState 是异步的，
   * setTimeout 回调里执行的是上一次 render 的闭包，读到的还是旧值（空串），
   * 于是「读取剪贴板」「Ctrl+V 自动解析」全都解析了个空内容。
   * 这里每次 render 同步刷新 ref，定时器触发时读到的必然是最新值。
   */
  const textRef = useRef(text);
  const imageRef = useRef(image);
  textRef.current = text;
  imageRef.current = image;

  async function parseChat(input?: { image?: string; text?: string }) {
    const srcImage = input?.image ?? imageRef.current;
    const srcText = input?.text ?? textRef.current;
    if (!srcImage && !srcText.trim()) {
      setError("粘贴群消息文字，或直接 Ctrl+V 粘贴聊天截图");
      return;
    }
    setParsing(true);
    setError("");
    setResultMsg("");
    try {
      const list = srcImage
        ? await parseChatImageToMeetings(srcImage, groupName.trim() || null)
        : await parseChatToMeetings(srcText, groupName.trim() || null);
      if (!list.length) {
        setError("这段内容里没找到带明确时间的会议。如果时间写在别处，把上下文一起复制进来。");
      } else {
        setMeetings(list.map((m) => ({ ...m, selected: true })));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败，请重试");
    }
    setParsing(false);
  }

  /** 从剪贴板里取图片（截图直接 Ctrl+V 到这里） */
  async function grabImageFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          const url = await blobToDataUrl(blob);
          setImage(url);
          setText("");
          await parseChat({ image: url, text: "" });
          return;
        }
      }
      setError("剪贴板里没有图片，先截图（Win+Shift+S）再点这里");
    } catch {
      setError("浏览器未授权读剪贴板，请直接 Ctrl+V 粘贴截图");
    }
  }

  function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("读取图片失败"));
      r.readAsDataURL(blob);
    });
  }

  function patchMeeting(index: number, patch: Partial<MeetingRow>) {
    setMeetings((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  async function saveMeetings() {
    const picked = meetings.filter((m) => m.selected);
    if (!picked.length) {
      setError("先勾选要加入日历的会议");
      return;
    }
    const missing = picked.filter((m) => !m.date);
    if (missing.length) {
      setError(`有 ${missing.length} 条没识别出日期，请先补齐（或取消勾选）`);
      return;
    }
    setSavingMeetings(true);
    setError("");
    try {
      for (const m of picked) {
        const startTime = m.startTime || "09:00";
        // 群聊里排出来的会议只进本机：正文里有别人的话、有私人安排，没有理由上云
        addMyEvent({
          kind: m.type === "deadline" ? "deadline" : "meeting",
          title: m.title,
          startAt: new Date(`${m.date}T${startTime}:00`).toISOString(),
          endAt: m.endTime ? new Date(`${m.date}T${m.endTime}:00`).toISOString() : undefined,
          allDay: !m.startTime,
          location: m.location || undefined,
          note: buildMeetingNote(m),
        });
      }
      setResultMsg(`已加入 ${picked.length} 条（会议 ${picked.filter((m) => m.type !== "deadline").length} / 截止 ${picked.filter((m) => m.type === "deadline").length}）`);
      setMeetings([]);
      setText("");
      setImage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
    setSavingMeetings(false);
  }

  async function parse(input?: { text?: string }) {
    const srcText = input?.text ?? textRef.current;
    if (mode === "chat") {
      await parseChat({ text: srcText });
      return;
    }
    if (!srcText.trim()) {
      setError("先粘贴内容再解析");
      return;
    }
    setParsing(true);
    setError("");
    setResultMsg("");
    try {
      if (mode === "event") {
        const firstLine = srcText.trim().split("\n")[0].slice(0, 60) || "粘贴通知";
        const form = await parseNoticeToEvent(firstLine, srcText);
        setEventForm(form);
      } else {
        // auto / ddl：先按作业列表解析；auto 模式下无结果则回退通知解析
        let list: Awaited<ReturnType<typeof parseDdlText>> = [];
        let ddlError: unknown = null;
        try {
          list = await parseDdlText(srcText);
        } catch (e) {
          ddlError = e;
        }
        if (list.length > 0) {
          setCandidates(list.map((c) => ({ ...c, selected: true })));
        } else if (mode === "auto") {
          const firstLine = srcText.trim().split("\n")[0].slice(0, 60) || "粘贴通知";
          const form = await parseNoticeToEvent(firstLine, srcText);
          setEventForm(form);
        } else if (ddlError) {
          throw ddlError;
        } else {
          setError("没有识别到作业条目，试试粘贴完整的作业列表页文字");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败，请重试");
    }
    setParsing(false);
  }

  /** 粘贴即解析：无需再点按钮。群聊模式下优先接截图 */
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"));
    if (file && mode === "chat") {
      e.preventDefault();
      void blobToDataUrl(file).then((url) => {
        setImage(url);
        setText("");
        return parseChat({ image: url, text: "" });
      });
      return;
    }
    // 粘贴的文本要等 React 把 value 写回 state 之后才读得到，
    // 所以延迟一帧再走解析；parse 读的是 textRef，不是闭包里的旧 state
    setTimeout(() => {
      void parse();
    }, 120);
  }

  /** 一键读取剪贴板（浏览器授权后自动解析） */
  async function readClipboard() {
    try {
      const content = await navigator.clipboard.readText();
      if (!content.trim()) {
        setError("剪贴板是空的，先复制内容");
        return;
      }
      setText(content);
      await parse({ text: content });
    } catch {
      setError("浏览器未授权读取剪贴板，请用 Ctrl+V 粘贴（粘贴后会自动解析）");
    }
  }

  function patchCandidate(index: number, patch: Partial<Candidate>) {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function importSelected() {
    const selected = candidates.filter((c) => c.selected && c.date);
    if (selected.length === 0) {
      setError("请至少勾选一条带截止日期的作业（无日期的请手动补充）");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const r = importDdls(
        selected.map((c) => ({
          course: c.course,
          title: c.title,
          dueAt: new Date(`${c.date}T${c.time || "23:59"}:00`).toISOString(),
          note: "粘贴导入",
          // 不传就落成 lms-sync 默认值，徽章会误显示「畅课」
          source: "paste-import",
        }))
      );
      setResultMsg(`导入完成：新增 ${r.added} 条、更新 ${r.updated} 条、跳过 ${r.skipped} 条（只存本机）`);
      setCandidates([]);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    }
    setImporting(false);
  }

  async function saveEvent() {
    if (!eventForm) return;
    if (!eventForm.date) {
      setError("请补充事件日期后再保存");
      return;
    }
    setSavingEvent(true);
    setError("");
    try {
      const payload = {
        kind: eventForm.kind,
        title: eventForm.title,
        startAt: new Date(`${eventForm.date}T${eventForm.time || "09:00"}:00`).toISOString(),
        endAt: eventForm.endDate
          ? new Date(`${eventForm.endDate}T23:59:00`).toISOString()
          : undefined,
        link: eventForm.link || undefined,
        allDay: !eventForm.time,
        location: eventForm.location || undefined,
        scope: eventForm.scope,
        college: eventForm.scope === "college" ? eventForm.college || undefined : undefined,
        grade: eventForm.scope === "grade" ? eventForm.grade || undefined : undefined,
        source: "paste-import",
      };
      // 和日历面板同一条规则：仅自己留本机，全校/学院/年级才写云库
      // （ParsedEvent 的 scope 类型不含 personal，但下拉框里有，运行时确实会出现）
      if ((eventForm.scope as string) === "personal") {
        addMyEvent({
          kind: payload.kind,
          title: payload.title,
          startAt: payload.startAt,
          endAt: payload.endAt,
          link: payload.link,
          allDay: payload.allDay,
          location: payload.location,
          note: "粘贴导入 · 仅自己",
        });
      } else {
        await createEvent(payload);
      }
      setResultMsg("事件已保存到日历");
      setEventForm(null);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
    setSavingEvent(false);
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        {(["auto", "chat", "ddl", "event"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setCandidates([]);
              setEventForm(null);
              setMeetings([]);
              setError("");
              setResultMsg("");
            }}
            className={`rounded-full px-4 py-1.5 text-sm ${
              mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            {m === "auto"
              ? "智能识别"
              : m === "chat"
                ? "群聊 / 会议"
                : m === "ddl"
                  ? "作业列表"
                  : "通知 / 活动"}
          </button>
        ))}
        {mode === "chat" && (
          <button
            onClick={grabImageFromClipboard}
            className="ml-auto rounded-lg border border-violet-200 px-3 py-1.5 text-sm text-violet-600 hover:bg-violet-50"
          >
            读剪贴板截图
          </button>
        )}
        {mode !== "chat" && (
          <button
            onClick={readClipboard}
            className="ml-auto rounded-lg border border-violet-200 px-3 py-1.5 text-sm text-violet-600 hover:bg-violet-50"
          >
            读取剪贴板
          </button>
        )}
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm">
        <p className="mb-2 text-sm text-gray-500">
          {mode === "chat"
            ? "在微信 / 企业微信的通知群里全选复制消息，或直接截图（Win+Shift+S）后 Ctrl+V 粘到下面的框里。AI 会找出所有带时间的会议，并给出建议的提醒时间。"
            : mode === "ddl"
              ? "打开畅课「我的作业 / 待办」页面，全选复制（Ctrl+A → Ctrl+C）后粘贴到这里，AI 自动提取作业和截止时间"
              : "粘贴班级群、公众号或公文通的通知文字，AI 提取时间地点生成日历事件"}
        </p>
        {mode === "chat" && (
          <label className="mb-2 block text-xs text-gray-500">
            群名（可选，方便回溯）
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="如：计软 2026 级通知群"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
            />
          </label>
        )}
        {mode === "chat" && image && (
          <div className="mb-2 flex items-start gap-3 rounded-lg bg-gray-50 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="聊天截图" className="max-h-48 rounded border border-gray-200" />
            <button
              onClick={() => setImage("")}
              className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:text-red-500"
            >
              移除
            </button>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          rows={mode === "chat" && image ? 3 : 8}
          placeholder={
            mode === "chat"
              ? "Ctrl+V 粘贴群消息文字或聊天截图，粘贴后自动解析"
              : "Ctrl+V 粘贴后自动解析，也可点上方「读取剪贴板」"
          }
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => void parse()}
            disabled={parsing}
            className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {parsing ? (image ? "识别截图中…" : "AI 解析中…") : mode === "chat" ? "提取会议" : "AI 解析"}
          </button>
          {resultMsg && <span className="text-sm text-emerald-600">{resultMsg}</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>

      {meetings.length > 0 && (
        <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
          <p className="mb-1 text-sm text-gray-600">
            识别到 <b>{meetings.length}</b> 条（会议 {meetings.filter((m) => m.type !== "deadline").length}、截止 {meetings.filter((m) => m.type === "deadline").length}），确认后加入日历（时间、地点、提醒都可改）：
          </p>
          <p className="mb-3 text-xs text-gray-400">
            提醒目前记为事件备注里的「提前 N 分钟」，接入推送后按这个值发提醒。
          </p>
          <div className="space-y-3">
            {meetings.map((m, index) => (
              <div key={index} className="rounded-lg bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={m.selected}
                    onChange={(e) => patchMeeting(index, { selected: e.target.checked })}
                  />
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      m.type === "deadline" ? "bg-orange-50 text-orange-600" : "bg-cyan-50 text-cyan-700"
                    }`}
                  >
                    {m.type === "deadline" ? "截止" : "会议"}
                  </span>
                  <input
                    value={m.title}
                    onChange={(e) => patchMeeting(index, { title: e.target.value })}
                    className="min-w-40 flex-1 rounded-md border border-gray-200 px-2 py-1 text-sm"
                  />
                  <input
                    type="date"
                    value={m.date || ""}
                    onChange={(e) => patchMeeting(index, { date: e.target.value || null })}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs"
                  />
                  <input
                    type="time"
                    value={m.startTime || ""}
                    onChange={(e) => patchMeeting(index, { startTime: e.target.value || null })}
                    className="w-24 rounded-md border border-gray-200 px-2 py-1 text-xs"
                  />
                  <span className="text-gray-400">→</span>
                  <input
                    type="time"
                    value={m.endTime || ""}
                    onChange={(e) => patchMeeting(index, { endTime: e.target.value || null })}
                    className="w-24 rounded-md border border-gray-200 px-2 py-1 text-xs"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <input
                    value={m.location || ""}
                    onChange={(e) => patchMeeting(index, { location: e.target.value || null })}
                    placeholder="地点 / 会议号"
                    className="min-w-32 flex-1 rounded-md border border-gray-200 px-2 py-1"
                  />
                  <select
                    value={m.remindBefore}
                    onChange={(e) => patchMeeting(index, { remindBefore: Number(e.target.value) })}
                    className="rounded-md border border-gray-200 bg-white px-2 py-1"
                  >
                    {REMIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {m.group && (
                    <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-600">{m.group}</span>
                  )}
                </div>
                {m.quote && <p className="mt-1 text-xs text-gray-400">原话：{m.quote}</p>}
                {!m.date && (
                  <p className="mt-1 text-xs text-amber-600">
                    没识别出日期，请手动选一个，否则不会加入日历
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={saveMeetings}
            disabled={savingMeetings}
            className="mt-4 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {savingMeetings
              ? "保存中…"
              : `加入日历（${meetings.filter((m) => m.selected).length} 场）`}
          </button>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
          <p className="mb-3 text-sm text-gray-600">
            识别到 <b>{candidates.length}</b> 条作业，勾选后导入（课程、标题、日期都可修改）：
          </p>
          <div className="space-y-2">
            {candidates.map((c, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2 text-sm">
                <input
                  type="checkbox"
                  checked={c.selected}
                  onChange={(e) => patchCandidate(index, { selected: e.target.checked })}
                />
                <input
                  value={c.course}
                  onChange={(e) => patchCandidate(index, { course: e.target.value })}
                  className="w-32 rounded-md border border-gray-200 px-2 py-1 text-xs"
                />
                <input
                  value={c.title}
                  onChange={(e) => patchCandidate(index, { title: e.target.value })}
                  className="min-w-40 flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs"
                />
                <input
                  type="date"
                  value={c.date || ""}
                  onChange={(e) => patchCandidate(index, { date: e.target.value || null })}
                  className="rounded-md border border-gray-200 px-2 py-1 text-xs"
                />
                <input
                  type="time"
                  value={c.time || ""}
                  onChange={(e) => patchCandidate(index, { time: e.target.value || null })}
                  className="w-24 rounded-md border border-gray-200 px-2 py-1 text-xs"
                />
              </div>
            ))}
          </div>
          <button
            onClick={importSelected}
            disabled={importing}
            className="mt-4 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {importing ? "导入中…" : `导入所选（${candidates.filter((c) => c.selected).length} 条）`}
          </button>
        </div>
      )}

      {eventForm && (
        <div className="mt-4 rounded-xl bg-white p-5 shadow-sm">
          <p className="mb-3 text-sm text-gray-600">AI 解析结果，确认后保存到日历：</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-gray-500">
              类型
              <select
                value={eventForm.kind}
                onChange={(e) => setEventForm({ ...eventForm, kind: e.target.value as ParsedEvent["kind"] })}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
              >
                <option value="exam">考试</option>
                <option value="pe">体测</option>
                <option value="activity">活动</option>
                <option value="meeting">会议</option>
                <option value="deadline">截止</option>
                <option value="other">其他</option>
              </select>
            </label>
            <label className="text-xs text-gray-500">
              标题
              <input
                value={eventForm.title}
                onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500">
              开始日期 *
              <input
                type="date"
                value={eventForm.date || ""}
                onChange={(e) => setEventForm({ ...eventForm, date: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500">
              结束日期（可选）
              <input
                type="date"
                value={eventForm.endDate || ""}
                onChange={(e) => setEventForm({ ...eventForm, endDate: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500">
              时间（可选）
              <input
                type="time"
                value={eventForm.time || ""}
                onChange={(e) => setEventForm({ ...eventForm, time: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500">
              地点（可选）
              <input
                value={eventForm.location || ""}
                onChange={(e) => setEventForm({ ...eventForm, location: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500 sm:col-span-2">
              链接（可选）
              <input
                value={eventForm.link || ""}
                onChange={(e) => setEventForm({ ...eventForm, link: e.target.value || null })}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-500">
              可见范围
              <select
                value={eventForm.scope}
                onChange={(e) => setEventForm({ ...eventForm, scope: e.target.value as ParsedEvent["scope"] })}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
              >
                <option value="personal">仅自己</option>
                <option value="school">全校</option>
                <option value="college">学院</option>
                <option value="grade">年级</option>
                <option value="undergraduate">本科生</option>
                <option value="postgraduate">硕士生</option>
                <option value="doctoral">博士生</option>
              </select>
            </label>
            {eventForm.scope === "college" && (
              <label className="text-xs text-gray-500">
                学院全名
                <input
                  value={eventForm.college || ""}
                  onChange={(e) => setEventForm({ ...eventForm, college: e.target.value || null })}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                />
              </label>
            )}
            {eventForm.scope === "grade" && (
              <label className="text-xs text-gray-500">
                年级（如 2026 级）
                <input
                  value={eventForm.grade || ""}
                  onChange={(e) => setEventForm({ ...eventForm, grade: e.target.value || null })}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                />
              </label>
            )}
          </div>
          <button
            onClick={saveEvent}
            disabled={savingEvent}
            className="mt-4 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {savingEvent ? "保存中…" : "保存到日历"}
          </button>
        </div>
      )}
    </div>
  );
}
