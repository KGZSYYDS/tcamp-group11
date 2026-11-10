import type { Adapter, RawRecord } from "../types";
import { makeRawRecord } from "../record";
import { normalizeTime } from "./generic-json";

/**
 * 畅课待办适配器。
 *
 * 这个形状是已知的（见 extension/parser.js 对 /api/todos 的解析），所以写专用适配器，
 * 不依赖通用兜底。特点：平台直接给截止时间，没有正文——走 structured 通道。
 *
 * 如果采集方换成别的字段名，只需要改这一个文件。
 */

interface LmsTodo {
  id?: number | string;
  title?: string;
  course_name?: string;
  course_id?: number | string;
  end_time?: string;
  start_time?: string;
  description?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function pickTodoList(payload: any): LmsTodo[] {
  if (Array.isArray(payload)) return payload as LmsTodo[];
  if (payload && Array.isArray(payload.todo_list)) return payload.todo_list as LmsTodo[];
  if (payload && Array.isArray(payload.data)) return payload.data as LmsTodo[];
  if (payload && payload.data && Array.isArray(payload.data.todo_list)) {
    return payload.data.todo_list as LmsTodo[];
  }
  return [];
}

export const lmsTodosAdapter: Adapter = (payload, ctx) => {
  const list = pickTodoList(payload);
  const records: RawRecord[] = [];

  for (const todo of list) {
    const title = String(todo.title || "").trim();
    if (!title) continue;

    const dueAt = todo.end_time ? normalizeTime(String(todo.end_time)) : undefined;
    const externalId = todo.id !== undefined ? `lms-todo:${todo.id}` : undefined;

    records.push(
      makeRawRecord({
        collector: ctx.collector,
        receivedAt: ctx.receivedAt,
        // 待办没有独立详情页，链接留给采集方补；这里不编造 URL
        url: "",
        title,
        content: todo.description ? String(todo.description) : "",
        externalId,
        department: todo.course_name ? String(todo.course_name) : undefined,
        structured: dueAt ? { occurAt: dueAt } : undefined,
        context: {
          courseId: String(todo.course_id ?? ""),
          course: String(todo.course_name ?? ""),
        },
      })
    );
  }

  return records;
};
