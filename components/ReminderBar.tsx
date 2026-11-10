"use client";

import { useCallback, useEffect, useState } from "react";

import { buildDeadlines } from "@/lib/deadlines";
import { listEvents } from "@/lib/data";
import { loadDdls, loadDoneKeys } from "@/lib/local-store";
import { computeReminders, reminderKey } from "@/lib/reminders.mjs";
import type { ReminderItem } from "@/lib/reminders.mjs";

/** 关掉的提醒：key@dueAt，改了截止时间会重新提醒 */
const DISMISS_KEY = "szu-calendar:reminder-dismissed:v1";
const REFRESH_MS = 60_000;

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]) {
  try {
    // 只留最近 200 条，避免无限增长
    localStorage.setItem(DISMISS_KEY, JSON.stringify(keys.slice(-200)));
  } catch {
    // 存不下就算了，最多下次再提示一次
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

function formatDue(dueAt: string): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const LEVEL_STYLE: Record<string, string> = {
  urgent: "border-rose-200 bg-rose-50/70 text-rose-900",
  soon: "border-amber-200 bg-amber-50/70 text-amber-900",
  today: "border-gray-200 bg-white text-gray-700",
};

export default function ReminderBar({
  onOpen,
  onCountChange,
}: {
  onOpen?: () => void;
  /** 供父级做 Tab 角标，只在数量变化时调用 */
  onCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<ReminderItem[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const events = await listEvents().catch(() => []);
      // buildDeadlines 内部已经合并了本机群聊截止
      const deadlines = buildDeadlines(loadDdls(), events, loadDoneKeys());
      const result = computeReminders(deadlines, { dismissed: readDismissed() });
      setItems(result.items);
      setOverdue(result.overdue);
      onCountChange?.(result.total);
    } catch {
      setItems([]);
      setOverdue(0);
      onCountChange?.(0);
    }
  }, [onCountChange]);

  useEffect(() => {
    refresh();
  }, [refresh, tick]);

  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  if (items.length === 0) return null;

  const next = items[0];
  const style = LEVEL_STYLE[next.level] || LEVEL_STYLE.today;

  const dismissAll = () => {
    const merged = new Set([...readDismissed(), ...items.map((item) => reminderKey(item))]);
    writeDismissed([...merged]);
    setItems([]);
    setOverdue(0);
    onCountChange?.(0);
    setTick((n) => n + 1);
  };

  return (
    <div className={`app-reminder rounded-xl border px-3 py-2 ${style}`}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
          {next.level === "urgent" ? "●" : "◔"}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-snug">
            还有 {items.length} 件要交 · 最近：{next.title}
            <span className="font-normal opacity-80"> {formatDue(next.dueAt)} 截止</span>
          </p>
          {overdue > 0 && (
            <p className="text-[10px] opacity-70">另有 {overdue} 条已过期</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {onOpen && (
            <button
              onClick={onOpen}
              className="rounded-md bg-white/80 px-2.5 py-1 text-xs font-medium shadow-sm ring-1 ring-black/5 hover:bg-white"
            >
              查看
            </button>
          )}
          <button
            onClick={dismissAll}
            aria-label="今天不再提示"
            title="今天不再提示"
            className="px-1 text-base leading-none opacity-50 hover:opacity-80"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
