"use client";

// Adapted from Magic UI Ripple Button (MIT). See THIRD_PARTY_UI.md.
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
type Ripple = { x: number; y: number; size: number; id: number };
function Wave({ item, remove }: { item: Ripple; remove: (id: number) => void }) {
  useEffect(() => { const id = setTimeout(() => remove(item.id), 600); return () => clearTimeout(id); }, [item.id, remove]);
  return <span aria-hidden="true" className="button-wave" style={{ left: item.x, top: item.y, width: item.size, height: item.size }} />;
}
export const RippleButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function RippleButton({ onClick, className = "", children, ...props }, ref) {
  const [waves, setWaves] = useState<Ripple[]>([]);
  const count = useRef(0);
  const remove = useCallback((id: number) => setWaves(prev => prev.filter(w => w.id !== id)), []);
  return <button ref={ref} {...props} className={`ripple-button ${className}`} onClick={e => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rect = e.currentTarget.getBoundingClientRect(), size = Math.max(rect.width, rect.height) * 2;
      const x = e.detail ? e.clientX - rect.left : rect.width / 2;
      const y = e.detail ? e.clientY - rect.top : rect.height / 2;
      setWaves(prev => [...prev, { x: x - size / 2, y: y - size / 2, size, id: ++count.current }]);
    }
    onClick?.(e);
  }}>{children}{waves.map(item => <Wave key={item.id} item={item} remove={remove} />)}</button>;
});
