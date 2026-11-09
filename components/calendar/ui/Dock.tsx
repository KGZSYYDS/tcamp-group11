"use client";

// 原型来自 react-bits 的 Dock：底部四个视图按钮，指针靠近时相邻项弹簧放大。
// 原组件还带右键菜单、嵌套菜单与自动隐藏等能力，本页只用到磁吸放大与选中态，
// 因此这里保留同一套弹簧手感与 DOM 结构，去掉未使用的菜单分支。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface DockItem {
  label: string;
  icon: ReactNode;
  active?: boolean;
  className?: string;
  onClick?: () => void;
}

interface DockProps {
  items: DockItem[];
  theme?: "light" | "dark";
  baseItemSize?: number;
  magnification?: number;
  distance?: number;
  panelHeight?: number;
  gap?: number;
  bounce?: boolean;
  tiles?: boolean;
  showLabels?: boolean;
  className?: string;
  style?: CSSProperties;
}

const THEMES: Record<"light" | "dark", Record<string, string>> = {
  light: {
    "--dock-panel": "rgba(240, 240, 243, 0.8)",
    "--dock-panel-edge": "rgba(24, 24, 27, 0.07)",
    "--dock-panel-highlight": "rgba(255, 255, 255, 0.95)",
    "--dock-panel-shadow":
      "0 22px 44px -22px rgba(24, 24, 27, 0.3), 0 6px 16px -10px rgba(24, 24, 27, 0.16)",
    "--dock-tile": "linear-gradient(180deg, #ffffff 0%, #f6f6f8 100%)",
    "--dock-tile-edge": "rgba(24, 24, 27, 0.08)",
    "--dock-tile-highlight": "rgba(255, 255, 255, 1)",
    "--dock-tile-shadow": "0 2px 6px -2px rgba(24, 24, 27, 0.16)",
    "--dock-ink": "#18181b",
    "--dock-label": "#2a2731",
    "--dock-label-ink": "#f4f4f5",
    "--dock-dot": "rgba(24, 24, 27, 0.45)",
    "--dock-separator": "rgba(24, 24, 27, 0.1)",
    "--dock-press": "brightness(0.94)",
  },
  dark: {
    "--dock-panel": "rgba(38, 35, 46, 0.66)",
    "--dock-panel-edge": "rgba(255, 255, 255, 0.08)",
    "--dock-panel-highlight": "rgba(255, 255, 255, 0.07)",
    "--dock-panel-shadow":
      "0 22px 44px -20px rgba(0, 0, 0, 0.8), 0 6px 16px -8px rgba(0, 0, 0, 0.5)",
    "--dock-tile": "linear-gradient(180deg, #3a3644 0%, #27242f 100%)",
    "--dock-tile-edge": "rgba(255, 255, 255, 0.07)",
    "--dock-tile-highlight": "rgba(255, 255, 255, 0.12)",
    "--dock-tile-shadow": "0 4px 10px -4px rgba(0, 0, 0, 0.7)",
    "--dock-ink": "#f4f4f5",
    "--dock-label": "#2a2731",
    "--dock-label-ink": "#f4f4f5",
    "--dock-dot": "rgba(255, 255, 255, 0.72)",
    "--dock-separator": "rgba(255, 255, 255, 0.12)",
    "--dock-press": "brightness(0.75)",
  },
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const EDGE = 12;

export default function Dock({
  items,
  theme = "light",
  baseItemSize = 50,
  magnification = 70,
  distance = 200,
  panelHeight = 68,
  gap = 10,
  bounce = true,
  tiles = true,
  showLabels = true,
  className = "",
  style,
}: DockProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [fit, setFit] = useState(1);

  const rawBase = Math.max(16, baseItemSize);
  const rawPeak = Math.max(rawBase, magnification);
  const thickness = Math.max(rawBase, panelHeight);
  const length =
    items.length * rawBase + gap * Math.max(0, items.length - 1) + thickness - rawBase;

  const base = rawBase * fit;
  const peak = rawPeak * fit;

  const settings = {
    base,
    peak,
    gap: gap * fit,
    distance: Math.max(1, distance) * fit,
    length: length + rawPeak - rawBase,
    bounce,
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const host = root.offsetParent ?? document.documentElement;
    const measure = () => {
      const room = host.clientWidth - EDGE * 2;
      const next = length > 0 ? Math.min(1, Math.max(0.4, room / length)) : 1;
      setFit(Math.round(next * 1000) / 1000);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [length]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const springs = new Map<number, { size: number; velocity: number; drawn: string; node: HTMLElement | null }>();
    const pointer = { x: 0, inside: false };
    let raf = 0;
    let last = 0;
    let alive = true;

    const enter = (index: number) => {
      let state = springs.get(index);
      if (!state) {
        state = { size: settingsRef.current.base, velocity: 0, drawn: "", node: null };
        springs.set(index, state);
      }
      return state;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!alive) return;
      const s = settingsRef.current;
      const dt = Math.min(1 / 30, Math.max(0.001, (now - last) / 1000));
      last = now;

      const rect = root.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      let cursor = -(items.length * s.base + s.gap * Math.max(0, items.length - 1)) / 2;
      const rests = items.map(() => {
        const middle = cursor + s.base / 2;
        cursor += s.base + s.gap;
        return middle;
      });
      const focus = pointer.inside ? pointer.x - center : null;
      const steps = Math.max(1, Math.ceil(dt * 240));
      const h = dt / steps;
      const k = 150 / 0.1;
      const c = 12 / 0.1;
      let moving = false;

      items.forEach((item, index) => {
        const node = itemRefs.current[index];
        if (!node) return;
        const state = enter(index);
        state.node = node;
        const reach = focus === null ? 1 : Math.abs(focus - rests[index]) / s.distance;
        const target = s.base + (s.peak - s.base) * (reach < 1 ? Math.cos((reach * Math.PI) / 2) ** 2 : 0);
        if (reduce) {
          state.size = target;
          state.velocity = 0;
        } else {
          for (let i = 0; i < steps; i++) {
            state.velocity = (state.velocity + h * k * (target - state.size)) / (1 + h * c + h * h * k);
            state.size += state.velocity * h;
          }
          if (Math.abs(target - state.size) > 0.1 || Math.abs(state.velocity) > 0.1) moving = true;
        }
        const size = Math.round(state.size * 10) / 10;
        const key = String(size);
        if (state.drawn !== key) {
          state.drawn = key;
          node.style.width = `${size}px`;
          node.style.height = `${size}px`;
        }
      });

      if (moving || pointer.inside) raf = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (raf || !alive) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    const onMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.inside = matchMedia("(hover: hover) and (pointer: fine)").matches;
      wake();
    };
    const onLeave = () => {
      pointer.inside = false;
      wake();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerleave", onLeave);
    wake();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [items]);

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="视图切换"
      className={`dock dock--bottom${tiles ? "" : " dock--bare"}${className ? ` ${className}` : ""}`}
      style={{ ...(THEMES[theme] ?? THEMES.light), "--dock-thickness": `${thickness}px`, "--dock-gap": `${gap * fit}px`, ...style } as CSSProperties}
    >
      <div className="dock-panel">
        {items.map((item, index) => (
          <button
            key={item.label}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            className={`dock-item${item.className ? ` ${item.className}` : ""}`}
            aria-label={item.label}
            aria-pressed={Boolean(item.active)}
            onClick={item.onClick}
            style={{ width: base, height: base }}
          >
            <span className="dock-tile">
              <span className="dock-face">{item.icon}</span>
            </span>
            {item.active ? <span className="dock-dot" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      {showLabels ? (
        <div className="dock-labels" aria-hidden="true">
          {items.map((item) => (
            <span key={item.label} className={item.active ? "active" : ""}>
              {item.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
