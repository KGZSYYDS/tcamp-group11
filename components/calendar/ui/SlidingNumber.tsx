"use client";

// Adapted from ibelick/motion-primitives, MIT. Commit 120f64f6.
// 用原生 ResizeObserver 替代 react-use-measure，位数变化时逐位滚动。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useSpring, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { useReducedMotion } from "./useMotionPreference";

function NumberGlyph({
  value,
  number,
  height,
}: {
  value: MotionValue<number>;
  number: number;
  height: number;
}) {
  const y = useTransform(value, (latest: number) => {
    const offset = (10 + number - (latest % 10)) % 10;
    return (offset > 5 ? offset - 10 : offset) * height;
  });
  return (
    <motion.span className="sliding-glyph" style={{ y }}>
      {number}
    </motion.span>
  );
}

function Digit({ value, place }: { value: number; place: number }) {
  const digit = Math.floor(value / place) % 10;
  const spring = useSpring(digit, { stiffness: 280, damping: 24, mass: 0.3 });
  const ref = useRef<HTMLSpanElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      setHeight(entries[0].contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    spring.set(digit);
  }, [digit, spring]);

  return (
    <span className="sliding-digit">
      <span
        ref={ref}
        style={{ display: "block", visibility: height ? "hidden" : "visible" }}
      >
        {digit}
      </span>
      {height > 0
        ? Array.from({ length: 10 }, (_, i) => (
            <NumberGlyph key={i} value={spring} number={i} height={height} />
          ))
        : null}
    </span>
  );
}

export function SlidingNumber({
  value,
  padStart = false,
}: {
  value: number;
  padStart?: boolean;
}) {
  const reduced = useReducedMotion();
  const digits = String(Math.max(0, Math.floor(value))).padStart(padStart ? 2 : 1, "0");
  if (reduced) return <span className="sliding-number">{digits}</span>;
  return (
    <span className="sliding-number" aria-hidden="true">
      {[...digits].map((_, i) => (
        <Digit key={digits.length - i} value={value} place={10 ** (digits.length - i - 1)} />
      ))}
    </span>
  );
}
