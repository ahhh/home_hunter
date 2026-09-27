import { useEffect, useRef, type ReactNode } from "react";

/** Side drawer over the map (bottom sheet on phones). Takes focus on open and returns it on close. */
export function Drawer({ label, onClose, children, className = "" }: { label: string; onClose(): void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("h2")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("dialog")) onClose();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <section ref={ref} className={`drawer ${className}`} aria-label={label}>
      <button className="drawer-close" onClick={onClose} aria-label={`Close ${label}`}>
        ×
      </button>
      {children}
    </section>
  );
}
