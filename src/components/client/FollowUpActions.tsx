"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "./api";

export function FollowUpActions({ id, businessId, defaultWhen }: { id: string; businessId: string; defaultWhen: string }) {
  const router = useRouter();
  const [when, setWhen] = useState(defaultWhen);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (url: string, body: unknown) => {
    setErr(null);
    const r = await callApi(url, body);
    if (!r.ok) return setErr(r.error ?? "Грешка");
    router.refresh();
  };
  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <div className="flex flex-wrap gap-1.5">
        <Link href={`/calls?id=${businessId}`} className="btn btn-sm">
          Обади се
        </Link>
        <button type="button" className="btn btn-sm" onClick={() => act(`/api/followups/${id}/complete`, {})}>
          Приключи
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setShow((s) => !s)} aria-expanded={show}>
          Пренасрочи
        </button>
      </div>
      {show && (
        <form
          className="flex flex-wrap gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(`/api/followups/${id}/reschedule`, { dueAtLocal: when });
          }}
        >
          <label className="sr-only" htmlFor={`rs-${id}`}>
            Нова дата и час
          </label>
          <input id={`rs-${id}`} type="datetime-local" className="field min-h-9 w-auto py-1 text-sm" value={when} onChange={(e) => setWhen(e.target.value)} required />
          <button className="btn btn-sm btn-primary">Запази</button>
        </form>
      )}
      {err && (
        <p role="alert" className="text-xs text-bad">
          {err}
        </p>
      )}
    </div>
  );
}
