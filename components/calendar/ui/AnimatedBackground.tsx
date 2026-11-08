"use client";

// Adapted from ibelick/motion-primitives, MIT. Commit 120f64f6.
import { Children, cloneElement, useEffect, useId, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode, MouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Transition } from "motion/react";
import { useReducedMotion } from "./useMotionPreference";

interface AnimatedBackgroundProps {
  children: ReactNode;
  defaultValue?: string | null;
  onValueChange?: (id: string | null) => void;
  className?: string;
  transition?: Transition;
  enableHover?: boolean;
}

interface ChoiceProps {
  "data-id"?: string;
  "data-checked"?: boolean;
  className?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
}

/** 分段切换控件共用的滑动选中底，layoutId 让底块在选项间平滑移动 */
export function AnimatedBackground({
  children,
  defaultValue,
  onValueChange,
  className = "",
  transition,
  enableHover = false,
}: AnimatedBackgroundProps) {
  const [activeId, setActiveId] = useState<string | null>(defaultValue ?? null);
  const uniqueId = useId();
  const reduced = useReducedMotion();

  useEffect(() => {
    setActiveId(defaultValue ?? null);
  }, [defaultValue]);

  function activate(id: string | null) {
    setActiveId(id);
    onValueChange?.(id);
  }

  return Children.map(children, (child) => {
    const element = child as ReactElement<ChoiceProps>;
    const id = element.props["data-id"];

    return cloneElement(element, {
      className: `animated-choice ${element.props.className || ""}`,
      "data-checked": activeId === id,
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (!enableHover) activate(id ?? null);
        element.props.onClick?.(event);
      },
      onMouseEnter: (event: MouseEvent<HTMLElement>) => {
        if (enableHover && matchMedia("(hover: hover) and (pointer: fine)").matches) {
          activate(id ?? null);
        }
        element.props.onMouseEnter?.(event);
      },
      onMouseLeave: (event: MouseEvent<HTMLElement>) => {
        if (enableHover) activate(null);
        element.props.onMouseLeave?.(event);
      },
      children: (
        <>
          <AnimatePresence initial={false}>
            {activeId === id ? (
              <motion.span
                aria-hidden="true"
                className={`animated-choice-bg ${className}`}
                layoutId={`background-${uniqueId}`}
                initial={false}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : transition || { type: "spring", stiffness: 420, damping: 36 }
                }
              />
            ) : null}
          </AnimatePresence>
          <span className="animated-choice-content">{element.props.children}</span>
        </>
      ),
    }) as ReactElement;
  });
}

/** 供 style 属性使用的类型辅助：允许 CSS 自定义属性 */
export type CssVars = CSSProperties & Record<`--${string}`, string | number>;
