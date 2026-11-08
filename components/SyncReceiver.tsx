"use client";

import { useEffect, useState } from "react";
import type { DdlInput } from "@/lib/types";
import {
  createEvent,
  eventExistsBySourceUrl,
  importDdls,
  mergeProfileCourses,
} from "@/lib/data";
import { parseNoticeToEvent, type ParsedEvent } from "@/lib/llm";

interface Notice {
  title: string;
  content: string;
  department: string;
  publishedAt: string;
  url: string;
}

interface SyncPayload {
  ddls: DdlInput[];
  courses: string[];
  notices?: Notice[];
}

interface NoticeItem extends Notice {
  status: "idle" | "parsing" | "ready" | "saving" | "saved" | "error";
  form?: ParsedEvent;
  error?: string;
}

declare global {
  interface Window {
    __SZU_CAL_RECEIVER__?: boolean;
  }
}

export default function SyncReceiver() {
  const [payload, setPayload] = useState<SyncPayload | null>(null);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    window.__SZU_CAL_RECEIVER__ = true;
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== "szu-cal-extension" || data.type !== "sync") return;
      const p = data.payload;
      if (!p || !Array.isArray(p.ddls) || !Array.isArray(p.courses)) return;
      const ddls = (p.ddls as DdlInput[]).filter(
        (d) => d && d.title && d.course && !Number.isNaN(Date.parse(d.dueAt))
      );
      const rawNotices = Array.isArray(p.notices) ? p.notices : [];
      setNotices(
        rawNotices
          .filter((n: Notice) => n && n.title && n.content)
          .map((n: Notice) => ({ ...n, status: "idle" as const }))
      );
      setPayload({
        ddls,
        courses: p.courses.filter((c: unknown): c is string => typeof c === "string"),
      });
      setResult("");
      setError("");
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      delete window.__SZU_CAL_RECEIVER__;
    };
  }, []);

  async function confirmDdls() {
    if (!payload) return;
    setBusy(true);
    setError("");
    try {
      const r = await importDdls(payload.ddls);
      const c = await mergeProfileCourses(payload.courses);
      setResult(
        `作业导入完成：新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}；画像课程共 ${c.total} 门`
      );
      setPayload(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败，请重试");
    }
    setBusy(false);
  }

  function patchNotice(index: number, patch: Partial<NoticeItem>) {
    setNotices((prev) => prev.map((n, i) => (i === index ? { ...n, ...patch } : n)));
  }

  async function parseOne(index: number) {
    const item = notices[index];
    patchNotice(index, { status: "parsing", error: undefined });
    try {
      const form = await parseNoticeToEvent(item.title, item.content);
      patchNotice(index, { status: "ready", form });
    } catch (e) {
      patchNotice(index, {
        status: "error",
        error: e instanceof Error ? e.message : "解析失败",
      });
    }
  }

  async function saveOne(index: number) {
    const item = notices[index];
    const form = item.form;
    if (!form) return;
    if (!form.date) {
      patchNotice(index, { status: "error", error: "请补充事件日期后再保存" });
      return;
    }
    patchNotice(index, { status: "saving" });
    try {
      if (item.url && (await eventExistsBySourceUrl(item.url))) {
        patchNotice(index, { status: "saved", error: "该通知已有人采集过，无需重复导入" });
        return;
      }
      await createEvent({
        kind: form.kind,
        title: form.title,
        startAt: new Date(`${form.date}T${form.time || "09:00"}:00`).toISOString(),
        endAt: form.endDate
          ? new Date(`${form.endDate}T23:59:00`).toISOString()
          : undefined,
        link: form.link || undefined,
        allDay: !form.time,
        location: form.location || undefined,
        scope: form.scope,
        college: form.scope === "college" ? form.college || undefined : undefined,
        grade: form.scope === "grade" ? form.grade || undefined : undefined,
        note:
          [item.department, item.publishedAt].filter(Boolean).join(" · ") || undefined,
        sourceUrl: item.url || undefined,
        source: "gwt-sync",
      });
      patchNotice(index, { status: "saved" });
    } catch (e) {
      patchNotice(index, {
        status: "error",
        error: e instanceof Error ? e.message : "保存失败",
      });
    }
  }

  if (!payload && notices.length === 0 && !result) return null;

  return (
    <div className="fixed bottom-5 left-1/2 z-50 max-h-[75vh] w-[94vw] max-w-lg -translate-x-1/2 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl ring-1 ring-gray-100">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-medium text-indigo-600">同步助手</h3>
        <button
          onClick={() => {
            setPayload(null);
            setNotices([]);
            setResult("");
          }}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          关闭
        </button>
      </div>

      {result && <p className="mb-3 text-sm text-emerald-600">{result}</p>}
      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

      {payload && (
        <div className="mb-4 rounded-xl bg-indigo-50/50 p-4">
          <p className="text-sm text-gray-600">
            识别到 <b>{payload.ddls.length}</b> 条作业、<b>{payload.courses.length}</b> 门课程。
            按「课程 + 标题」去重，不重置完成状态。
          </p>
          <button
            onClick={confirmDdls}
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "导入中…" : "导入作业与课程"}
          </button>
        </div>
      )}

      {notices.length > 0 && (
        <div>
          <p className="mb-2 text-sm text-gray-600">
            <b>{notices.length}</b> 条公文通通知：AI 解析后确认，即成为公共事件（按范围共享给同学）
          </p>
          <div className="space-y-3">
            {notices.map((item, index) => (
              <div key={index} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {[item.department, item.publishedAt].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {item.status === "idle" && (
                    <button
                      onClick={() => parseOne(index)}
                      className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700"
                    >
                      AI 解析
                    </button>
                  )}
                  {item.status === "parsing" && (
                    <span className="shrink-0 text-xs text-violet-500">AI 解析中…</span>
                  )}
                  {item.status === "saved" && (
                    <span className="shrink-0 text-xs text-emerald-600">已加入日历</span>
                  )}
                </div>

                {item.status === "error" && (
                  <div className="mt-2 flex items-center gap-2">
                    <p className="text-xs text-red-500">{item.error}</p>
                    <button
                      onClick={() => parseOne(index)}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      重试
                    </button>
                  </div>
                )}
                {item.status === "saved" && item.error && (
                  <p className="mt-1 text-xs text-amber-600">{item.error}</p>
                )}

                {(item.status === "ready" || item.status === "saving") && item.form && (
                  <div className="mt-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={item.form.kind}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, kind: e.target.value as ParsedEvent["kind"] },
                          })
                        }
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
                      >
                        <option value="exam">考试</option>
                        <option value="pe">体测</option>
                        <option value="activity">活动</option>
                        <option value="other">其他</option>
                      </select>
                      <input
                        value={item.form.title}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, title: e.target.value },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        type="date"
                        value={item.form.date || ""}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, date: e.target.value },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        type="time"
                        value={item.form.time || ""}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, time: e.target.value || null },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        type="date"
                        title="结束日期（时间段事件可选）"
                        value={item.form.endDate || ""}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, endDate: e.target.value || null },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        value={item.form.link || ""}
                        placeholder="预约 / 详情链接（可选）"
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, link: e.target.value || null },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <input
                        value={item.form.location || ""}
                        placeholder="地点"
                        onChange={(e) =>
                          patchNotice(index, {
                            form: { ...item.form!, location: e.target.value || null },
                          })
                        }
                        className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                      <select
                        value={item.form.scope}
                        onChange={(e) =>
                          patchNotice(index, {
                            form: {
                              ...item.form!,
                              scope: e.target.value as ParsedEvent["scope"],
                            },
                          })
                        }
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
                      >
                        <option value="school">全校</option>
                        <option value="college">学院</option>
                        <option value="grade">年级</option>
                        <option value="undergraduate">本科生</option>
                        <option value="postgraduate">硕士生</option>
                        <option value="doctoral">博士生</option>
                      </select>
                      {item.form.scope === "college" && (
                        <input
                          value={item.form.college || ""}
                          placeholder="学院全名"
                          onChange={(e) =>
                            patchNotice(index, {
                              form: { ...item.form!, college: e.target.value || null },
                            })
                          }
                          className="col-span-2 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                        />
                      )}
                      {item.form.scope === "grade" && (
                        <input
                          value={item.form.grade || ""}
                          placeholder="如 2026 级"
                          onChange={(e) =>
                            patchNotice(index, {
                              form: { ...item.form!, grade: e.target.value || null },
                            })
                          }
                          className="col-span-2 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                        />
                      )}
                    </div>
                    <button
                      onClick={() => saveOne(index)}
                      disabled={item.status === "saving"}
                      className="w-full rounded-lg bg-emerald-600 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {item.status === "saving" ? "保存中…" : "保存为公共事件"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(result || notices.some((n) => n.status === "saved")) && (
        <button
          onClick={() => window.location.reload()}
          className="mt-4 w-full rounded-lg border border-indigo-200 py-2 text-sm text-indigo-600 hover:bg-indigo-50"
        >
          完成，刷新日历查看
        </button>
      )}
    </div>
  );
}
