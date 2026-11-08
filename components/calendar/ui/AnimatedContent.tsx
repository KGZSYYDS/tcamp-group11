"use client";

// 原型使用 react-bits 的 AnimatedContent 做时间轴进入视野时的显现。
// 这里保留同一对外接口里实际用到的部分（distance / duration / threshold / once），
// 改用 IntersectionObserver + CSS transition 实现，避免为一次短位移动画引入 gsap。
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { useReducedMotion } from "./useMotionPreference";

interface AnimatedContentProps {
  children: ReactNode;
  /** 动画位移动量（px） */
  distance?: number;
  /** 动画时长（秒） */
  duration?: number;
  /** 进入视野的触发阈值 0–1 */
  threshold?: number;
  /** 只播放一次 */
  once?: boolean;
  /** 滚动容器选择器；默认取最近的可滚动祖先 */
  container?: string;
  delay?: number;
  className?: string;
  style?: CSSProperties;
  as?: ElementType;
}

export default function AnimatedContent({
  children,
  distance = 10,
  duration = 0.24,
  threshold = 0,
  once = true,
  container,
  delay = 0,
  className = "",
  style,
  as: Tag = "div",
}: AnimatedContentProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const node = ref.current;
    if (!node) return;

    const root = container ? (document.querySelector(container) as Element | null) : null;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((entry) => entry.isIntersecting);
        if (!hit) return;
        setShown(true);
        if (once) observer.disconnect();
        else if (!entries.some((entry) => entry.isIntersecting)) setShown(false);
      },
      { root, threshold, rootMargin: "0px 0px -4% 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [container, once, threshold, reduced]);

  const motionStyle: CSSProperties = reduced
    ? {}
    : {
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : `translateY(${distance}px)`,
        transition: shown
          ? `opacity ${duration}s var(--ease-out) ${delay}s, transform ${duration}s var(--ease-out) ${delay}s`
          : "none",
      };

  return (
    <Tag ref={ref} className={className} style={{ ...motionStyle, ...style }}>
      {children}
    </Tag>
  );
}
