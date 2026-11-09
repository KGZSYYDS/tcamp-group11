"use client";

import { useState } from "react";
import { createEvent, importDdls } from "@/lib/data";
import {
  parseDdlText,
  parseNoticeToEvent,
  type DdlCandidate,
  type ParsedEvent,
} from "@/lib/llm";

interface Candidate extends DdlCandidate {
  selected: boolean;
}

export default function PasteImporter() {
  const [mode, setMode] = useState<"auto" | "ddl" | "event">("auto");
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [resultMsg, setResultMsg] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [importing, setImporting] = useState(false);
  const [eventForm, setEventForm] = useState<ParsedEvent | null>(null);
  const [savingEvent, setSavingEvent] = useState(false);

  async function parse() {
    if (!text.trim()) {
      setError("先粘贴内容再解析");
      return;
    }
    setParsing(true);
    setError("");
    setResultMsg("");
    try {
      if (mode === "event") {
        const firstLine = text.trim().split("\n")[0].slice(0, 60) || "粘贴通知";
        const form = await parseNoticeToEvent(firstLine, text);
        setEventForm(form);
      } else {
        // auto / ddl：先按作业列表解析；auto 模式下无结果则回退通知解析
        let list: Awaited<ReturnType<typeof parseDdlText>> = [];
        let ddlError: unknown = null;
        try {
          list = await parseDdlText(text);
        } catch (e) {
          ddlError = e;
        }
        if (list.length > 0) {
          setCandidates(list.map((c) => ({ ...c, selected: true })));
        } else if (mode === "auto") {
          const firstLine = text.trim().split("\n")[0].slice(0, 60) || "粘贴通知";
          const form = await parseNoticeToEvent(firstLine, text);
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

  /** 粘贴即解析：无需再点按钮 */
  function handlePaste() {
    setTimeout(() => {
      parse();
    }, 150);
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
      setTimeout(() => parse(), 100);
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
      const r = await importDdls(
        selected.map((c) => ({
          course: c.course,
          title: c.title,
          dueAt: new Date(`${c.date}T${c.time || "23:59"}:00`).toISOString(),
          note: "粘贴导入",
        }))
      );
      setResultMsg(`导入完成：新增 ${r.added} 条、更新 ${r.updated} 条、跳过 ${r.skipped} 条`);
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
      await createEvent({
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
      });
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
      <div className="import-toolbar mb-3 flex flex-wrap items-center gap-2">
        {(["auto", "ddl", "event"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setCandidates([]);
              setEventForm(null);
              setError("");
              setResultMsg("");
            }}
            className={`rounded-full px-4 py-1.5 text-sm ${
              mode === m ? "bg-indigo-600 text-white" : "bg-white text-gray-600 hover:bg-gray-100"
            }`}
          >
            {m === "auto" ? "智能识别" : m === "ddl" ? "作业列表" : "通知 / 活动"}
          </button>
        ))}
        <button
          onClick={readClipboard}
          className="ml-auto rounded-lg border border-violet-200 px-3 py-1.5 text-sm text-violet-600 hover:bg-violet-50"
        >
          读取剪贴板
        </button>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm">
        <p className="mb-2 text-sm text-gray-500">
          {mode === "ddl"
            ? "打开畅课「我的作业 / 待办」页面，全选复制（Ctrl+A → Ctrl+C）后粘贴到这里，AI 自动提取作业和截止时间"
            : "粘贴班级群、公众号或公文通的通知文字，AI 提取时间地点生成日历事件"}
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          rows={6}
          placeholder="Ctrl+V 粘贴后自动解析，也可点上方「读取剪贴板」"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={parse}
            disabled={parsing}
            className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {parsing ? "AI 解析中…" : "AI 解析"}
          </button>
          {resultMsg && <span className="text-sm text-emerald-600">{resultMsg}</span>}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>

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
