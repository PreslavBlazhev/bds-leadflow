"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { callApi } from "./api";

const RESULT_TEXT = {
  publish: (d: unknown) => {
    const r = d as { created: boolean; added: number; total: number; target: number; paused?: boolean; shortfallReason?: string | null; blocked?: { ok: boolean; reason?: string } };
    if (r.paused) return "Новите списъци са на пауза — нищо не е създадено.";
    if (r.blocked && !r.blocked.ok) return `Нищо не е създадено: ${r.blocked.reason ?? "действието не е достъпно"}`;
    return r.created ? `Създаден: ${r.total}/${r.target}` : r.added ? `Допълнен с ${r.added} → ${r.total}/${r.target}` : `Списъкът вече съществува (${r.total}/${r.target}) — нищо ново не е генерирано.`;
  },
} as const;

/**
 * Бутон, който изпълнява реално backend действие и обновява страницата.
 * Ако действието не е налично — disabled с конкретна причина (видима, не само tooltip).
 */
export function ActionButton({
  url,
  body,
  children,
  className = "btn",
  disabledReason,
  onDone,
  confirmText,
  method = "POST",
  resultText,
  resultKind,
}: {
  url: string;
  body?: unknown;
  children: ReactNode;
  className?: string;
  disabledReason?: string | null;
  onDone?: (data: unknown) => void;
  confirmText?: string;
  method?: string;
  resultText?: (data: unknown) => string | null;
  /** Предефинирани съобщения — за server компоненти (функции не могат да се подават към client). */
  resultKind?: "publish";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const disabled = !!disabledReason || busy || pending;

  async function run() {
    if (confirmText && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setMsg(null);
    const r = await callApi(url, body ?? {}, method);
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? "Грешка" });
    else {
      const t = resultText?.(r.data) ?? (resultKind ? RESULT_TEXT[resultKind](r.data) : null);
      if (t) setMsg({ ok: true, text: t });
      onDone?.(r.data);
      start(() => router.refresh());
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" className={className} onClick={run} disabled={disabled} aria-describedby={disabledReason ? undefined : undefined}>
          {busy || pending ? "…" : confirming ? `Потвърди: ${confirmText}` : children}
        </button>
        {confirming && (
          <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
            Отказ
          </button>
        )}
      </span>
      {disabledReason && <span className="text-xs text-muted">Недостъпно: {disabledReason}</span>}
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>
          {msg.text}
        </span>
      )}
    </span>
  );
}
