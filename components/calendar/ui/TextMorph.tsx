"use client";

// Adapted from ibelick/motion-primitives, MIT. Commit 120f64f6.
// 相同字符通过 layoutId 复用，仅对差异字符做模糊淡入淡出。
import { useId, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "./useMotionPreference";

export function TextMorph({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  const uniqueId = useId();
  const reduced = useReducedMotion();
  const characters = useMemo(() => {
    const counts: Record<string, number> = {};
    return [...children].map((label) => {
      const key = label.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
      return { id: `${uniqueId}-${key}-${counts[key]}`, label: label === " " ? "\u00a0" : label };
    });
  }, [children, uniqueId]);

  if (reduced) return <span className={className}>{children}</span>;

  return (
    <span className={className} aria-label={children}>
      <AnimatePresence mode="popLayout" initial={false}>
        {characters.map((c) => (
          <motion.span
            key={c.id}
            layoutId={c.id}
            aria-hidden="true"
            style={{ display: "inline-block" }}
            initial={{ opacity: 0, filter: "blur(2px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(2px)" }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          >
            {c.label}
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}
