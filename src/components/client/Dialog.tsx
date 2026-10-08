"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/** Достъпен dialog: role=dialog, aria-modal, Escape затваря, фокусът влиза вътре и се връща след затваряне. */
export function Dialog({ open, onClose, title, children, wide, keepMounted }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; keepMounted?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const id = useId();
  useEffect(() => {
    if (!open) return;
    prev.current = document.activeElement;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute("disabled"));
    (focusables()[1] ?? focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (prev.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);
  // keepMounted: съдържанието (напр. незаписан резултат/бележка) остава при затваряне.
  if (!open && !keepMounted) return null;
  return (
    <div hidden={!open} className={`fixed inset-0 z-50 ${open ? "flex" : "hidden"} items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} className={`card max-h-[92vh] w-full overflow-y-auto bg-panel p-4 ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Затвори">
            ✕ <span className="sr-only">Затвори</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
