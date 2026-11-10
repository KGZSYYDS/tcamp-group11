"use client";

import { useEffect, useRef } from "react";
import { ChevronDown, X } from "lucide-react";
import { BOARD_GROUPS } from "@/lib/board-taxonomy.mjs";

export function CampusFilterButton({ enabled, count, onToggle, onOpen }: {
  enabled: boolean;
  count?: number;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef<{ x: number; y: number } | undefined>(undefined);
  const opened = useRef(false);
  const clear = () => {
    clearTimeout(hold.current);
    hold.current = undefined;
    started.current = undefined;
  };
  useEffect(() => () => clearTimeout(hold.current), []);
  return (
    <div className="campus-filter-trigger">
      <button
        type="button"
        aria-pressed={enabled}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clear();
          opened.current = false;
          started.current = { x: event.clientX, y: event.clientY };
          hold.current = setTimeout(() => {
            opened.current = true;
            onOpen();
          }, 480);
        }}
        onPointerMove={(event) => {
          if (started.current && Math.hypot(event.clientX - started.current.x, event.clientY - started.current.y) > 12) clear();
        }}
        onPointerUp={clear}
        onPointerCancel={clear}
        onPointerLeave={clear}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (event.detail && opened.current) {
            opened.current = false;
            return;
          }
          onToggle();
        }}
      ><i />校园{typeof count === "number" ? <span className="bucket-count">{count}</span> : null}</button>
      <button type="button" aria-label="校园细分筛选" aria-haspopup="dialog" onClick={onOpen}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function CampusFilterDialog({ open, off, onToggle, onReset, onClose }: {
  open: boolean;
  off: string[];
  onToggle: (key: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="dialog campus-filter-dialog"
      aria-label="校园细分筛选"
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="campus-filter-body">
        <header>
          <h2>校园细分筛选</h2>
          <button type="button" className="icon-button" aria-label="关闭校园细分筛选" onClick={onClose}><X size={18} /></button>
        </header>
        <p>勾选即显示。标为「待细分」的通知随所属大类显示。</p>
        <div className="campus-filter-groups">
          {BOARD_GROUPS.map(({ id, label, subtypes }) => {
            const enabled = !off.includes(id);
            return (
              <section key={id}>
                <div className="campus-group-heading">
                  <label><input type="checkbox" checked={enabled} onChange={() => onToggle(id)} />{label}</label>
                </div>
                <details>
                  <summary>小类 · {Object.keys(subtypes).filter((code) => !off.includes(`${id}:${code}`)).length}/{Object.keys(subtypes).length}</summary>
                  <div className="campus-subtypes">
                    {Object.entries(subtypes).map(([code, name]) => (
                      <label key={code}>
                        <input type="checkbox" disabled={!enabled} checked={!off.includes(`${id}:${code}`)}
                          onChange={() => onToggle(`${id}:${code}`)} />{name}
                      </label>
                    ))}
                  </div>
                </details>
              </section>
            );
          })}
        </div>
        <footer>
          <button type="button" className="subtle" onClick={onReset}>恢复全部</button>
          <button type="button" className="primary" onClick={onClose}>完成</button>
        </footer>
      </div>
    </dialog>
  );
}
