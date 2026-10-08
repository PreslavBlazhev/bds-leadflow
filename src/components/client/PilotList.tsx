"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "./api";

interface Item {
  id: string;
  status: string;
  statusLabel: string;
  city: string;
  category: string;
  businessId: string | null;
  note: string | null;
}

interface LiveView {
  live: { name: string | null; address: string | null; typeLabel: string | null; businessStatus: string | null; phone: string | null; internationalPhone: string | null; website: string | null; rating: number | null; reviewCount: number | null; mapsUri: string | null };
  missing: string[];
  history: { kind: "MATCH" | "NONE"; ref?: string; via?: string; dnc?: boolean; businessId?: string };
  source: string;
}

/** Живите данни се държат само в паметта на страницата (не се записват никъде). */
export function PilotList({ items, canLoad }: { items: Item[]; canLoad: boolean }) {
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <PilotRow key={it.id} it={it} canLoad={canLoad} />
      ))}
    </ul>
  );
}

function PilotRow({ it, canLoad }: { it: Item; canLoad: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<LiveView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(it.note ?? "");
  const [conv, setConv] = useState({ open: false, name: "", phone: "", website: "", confirmed: false });

  const act = async (url: string, body: unknown) => {
    setBusy(true);
    setErr(null);
    const r = await callApi<LiveView & { businessId?: string }>(url, body);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? "Грешка");
      return null;
    }
    return r.data!;
  };

  return (
    <li className="card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">
            {it.city} · {it.category} · {it.statusLabel}
          </div>
          <div className="font-medium">{v?.live.name ?? <span className="text-muted">Името се зарежда на живо от Google</span>}</div>
        </div>
        {it.status !== "CONVERTED" && it.status !== "IN_HISTORY" && (
          <button type="button" className="btn btn-sm" disabled={!canLoad || busy} onClick={async () => setV(await act("/api/pilot/load", { id: it.id }))}>
            {v ? "Обнови данните" : "Зареди данните"}
          </button>
        )}
        {it.businessId && (
          <Link href={`/leads/${it.businessId}`} className="btn btn-sm">
            Моят запис
          </Link>
        )}
      </div>

      {v && (
        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <dl className="space-y-0.5">
            <div>
              <dt className="inline text-muted">Телефон: </dt>
              <dd className="inline">
                {v.live.phone ?? v.live.internationalPhone ?? "—"}{" "}
                {it.status === "APPROVED" && (v.live.internationalPhone || v.live.phone) && (
                  <a className="btn btn-sm ml-1" href={`tel:${(v.live.internationalPhone ?? v.live.phone)!.replace(/\s/g, "")}`}>
                    Позвъни
                  </a>
                )}
              </dd>
            </div>
            <div>
              <dt className="inline text-muted">Адрес: </dt>
              <dd className="inline">{v.live.address ?? "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted">Тип: </dt>
              <dd className="inline">{v.live.typeLabel ?? "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted">Сайт: </dt>
              <dd className="inline break-all">{v.live.website ? <a href={v.live.website} target="_blank" rel="noopener noreferrer nofollow">{v.live.website}</a> : "—"}</dd>
            </div>
            <div>
              <dt className="inline text-muted">Рейтинг: </dt>
              <dd className="inline">{v.live.rating !== null ? `${v.live.rating} (${v.live.reviewCount ?? 0} отзива)` : "—"}</dd>
            </div>
          </dl>
          <div className="space-y-1">
            {v.missing.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {v.missing.map((m) => (
                  <span key={m} className="rounded-md border border-amber-700 px-1.5 py-0.5 text-xs text-warn">
                    ▲ {m}
                  </span>
                ))}
              </div>
            )}
            <div className={`text-xs ${v.history.kind === "MATCH" ? "text-bad" : "text-muted"}`}>
              {v.history.kind === "MATCH" ? `■ Съвпада с мой запис ${v.history.ref} (по ${v.history.via})${v.history.dnc ? " — DNC" : ""}. Не е нов.` : "Няма съвпадение в моята база (виж предупреждението за историята горе)."}
            </div>
            <div className="text-xs text-muted">
              Източник: {v.source}. {v.live.mapsUri && <a href={v.live.mapsUri} target="_blank" rel="noopener noreferrer nofollow">Виж в Google Maps</a>}
            </div>
          </div>
        </div>
      )}

      {it.status !== "CONVERTED" && it.status !== "IN_HISTORY" && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor={`pn-${it.id}`}>
              Бележка от прегледа
            </label>
            <input id={`pn-${it.id}`} className="field min-h-9 py-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {it.status !== "APPROVED" && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !v || v.history.kind === "MATCH"}
              title={!v ? "Първо зареди данните и ги прегледай" : undefined}
              onClick={async () => (await act("/api/pilot/review", { id: it.id, decision: "APPROVED", note })) && router.refresh()}
            >
              Одобри за обаждане
            </button>
          )}
          {it.status !== "REJECTED" && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => (await act("/api/pilot/review", { id: it.id, decision: "REJECTED", note })) && router.refresh()}>
              Отхвърли
            </button>
          )}
          {it.status === "APPROVED" && (
            <button type="button" className="btn btn-sm" onClick={() => setConv({ ...conv, open: !conv.open })} aria-expanded={conv.open}>
              След разговора: създай мой запис
            </button>
          )}
        </div>
      )}
      {!v && it.status === "PENDING_REVIEW" && <p className="mt-1 text-xs text-muted">Одобрение е възможно само след като прегледаш заредените данни.</p>}

      {conv.open && (
        <form
          className="mt-2 grid gap-2 rounded-md border border-line p-2 sm:grid-cols-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act("/api/pilot/convert", { id: it.id, name: conv.name, phone: conv.phone, website: conv.website || undefined, confirmedWithBusiness: conv.confirmed });
            if (r?.businessId) router.push(`/leads/${r.businessId}`);
          }}
        >
          <p className="text-xs text-muted sm:col-span-3">Въведи данните, които бизнесът потвърди в разговора. Те стават твои CRM данни; от Google се пази само place_id.</p>
          <div>
            <label className="label" htmlFor={`cn-${it.id}`}>
              Име (потвърдено)
            </label>
            <input id={`cn-${it.id}`} className="field" required value={conv.name} onChange={(e) => setConv({ ...conv, name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`cp-${it.id}`}>
              Телефон (на който говорихте)
            </label>
            <input id={`cp-${it.id}`} className="field" required value={conv.phone} onChange={(e) => setConv({ ...conv, phone: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`cw-${it.id}`}>
              Сайт (ако го потвърдиха)
            </label>
            <input id={`cw-${it.id}`} className="field" value={conv.website} onChange={(e) => setConv({ ...conv, website: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-3">
            <input type="checkbox" className="h-4 w-4" checked={conv.confirmed} onChange={(e) => setConv({ ...conv, confirmed: e.target.checked })} required /> Данните са потвърдени директно от бизнеса в разговора.
          </label>
          <div className="sm:col-span-3">
            <button className="btn btn-primary btn-sm">Създай запис и запиши резултата</button>
          </div>
        </form>
      )}
      {err && (
        <p role="alert" className="mt-1 text-sm text-bad">
          {err}
        </p>
      )}
    </li>
  );
}
