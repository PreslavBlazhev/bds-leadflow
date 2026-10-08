"use client";

import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";

/**
 * Предупреждение при незаписан резултат/бележка: beforeunload (reload/затваряне) + прихващане на вътрешни линкове
 * с in-app dialog. Draft-ът НЕ се пази в localStorage (лични данни).
 */
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.dataset.noguard !== undefined) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#") || href.startsWith("tel:")) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(a.href);
    };
    window.addEventListener("beforeunload", onBefore);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBefore);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
  return (
    <Dialog open={!!pendingHref} onClose={() => setPendingHref(null)} title="Незаписан резултат">
      <p className="mb-4 text-sm">Имаш избран резултат или бележка, които не са записани. Ако напуснеш, ще се загубят.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => setPendingHref(null)}>
          Остани и запиши
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            const h = pendingHref!;
            setPendingHref(null);
            window.removeEventListener("beforeunload", () => {});
            window.location.href = h;
          }}
        >
          Напусни без запис
        </button>
      </div>
    </Dialog>
  );
}
