"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { STAGE_LABELS, STAGES } from "@/domain/constants";
import { callApi } from "./api";

export function MoveStage({ businessId, current }: { businessId: string; current: string }) {
  const router = useRouter();
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (current === "WON") return <p className="mt-1 text-xs text-muted">Спечелен — управлява се от „Клиенти“.</p>;
  const options = STAGES.filter((s) => s !== current && s !== "NEW" && s !== "WON");
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!to) return;
        setErr(null);
        const r = await callApi("/api/pipeline/move", { businessId, toStage: to, reason: reason || undefined });
        if (!r.ok) return setErr(r.error ?? "Грешка");
        setTo("");
        setReason("");
        router.refresh();
      }}
    >
      <label className="sr-only" htmlFor={`mv-${businessId}`}>
        Премести в етап
      </label>
      <select id={`mv-${businessId}`} className="field min-h-9 w-auto flex-1 py-1 text-xs" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Премести в…</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      {to && (
        <>
          <label className="sr-only" htmlFor={`mvr-${businessId}`}>
            Причина
          </label>
          <input id={`mvr-${businessId}`} className="field min-h-9 w-full py-1 text-xs" placeholder={current === "LOST" ? "Причина (задължително)" : "Причина (по избор)"} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-sm">Премести</button>
        </>
      )}
      {err && (
        <p role="alert" className="w-full text-xs text-bad">
          {err}
        </p>
      )}
    </form>
  );
}
