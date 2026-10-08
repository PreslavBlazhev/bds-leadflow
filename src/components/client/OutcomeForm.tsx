"use client";

import { useEffect, useMemo, useState } from "react";
import { OUTCOME_HINTS, OUTCOME_LABELS, OUTCOMES, type Outcome } from "@/domain/constants";
import { fmtDateTime } from "@/lib/time";
import { callApi, newKey } from "./api";
import { UnsavedGuard } from "./UnsavedGuard";

export interface PackageOpt {
  key: string;
  label: string;
  oneTimeCents: number;
  monthlyCents: number | null;
}

function toCents(v: string): number | null {
  const s = v.replace(/\s|€/g, "").replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

const OUTCOME_TONE: Partial<Record<Outcome, string>> = {
  INTERESTED: "border-emerald-700",
  SEND_OFFER: "border-emerald-700",
  WON: "border-emerald-600",
  DECLINED: "border-amber-700",
  INVALID_NUMBER: "border-red-800",
  DO_NOT_CONTACT: "border-red-700",
};

/**
 * Деветте резултата като текстови бутони (без икони без обяснение). Idempotency key живее,
 * докато записът не успее — повторен клик/retry след мрежова грешка не създава втора дейност.
 */
export function OutcomeForm({
  businessId,
  blockedReason,
  packages,
  openOffers,
  today,
  onSaved,
  compact,
  submitLabel = "Запази резултата",
  shortcuts = false,
  retryDefault,
}: {
  businessId: string;
  blockedReason?: string | null;
  packages: PackageOpt[];
  openOffers: { id: string; service: string; oneTimeCents: number; monthlyCents: number | null }[];
  today: string;
  onSaved?: (r: { stage: string; duplicate: boolean; outcome: Outcome; retryAt?: string }) => void;
  compact?: boolean;
  submitLabel?: string;
  /** Клавиши 1–9 избират резултат (когато фокусът не е в текстово поле). */
  shortcuts?: boolean;
  /** „Не отговори“: предварително изчислено повторно обаждане (datetime-local, Europe/Sofia) и срокът в работни дни. */
  retryDefault?: { local: string; workdays: number };
}) {
  const [key, setKey] = useState(newKey);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [otherChannel, setOtherChannel] = useState(false);
  const [connected, setConnected] = useState<"" | "yes" | "no">("");
  const [when, setWhen] = useState("");
  // Изрично променената дата има предимство; иначе сървърът изчислява по правилото в момента на записа.
  const [whenTouched, setWhenTouched] = useState(false);
  /** Избор на резултат; при „Не отговори“ полето за дата се попълва с изчисленото повторно обаждане. */
  const choose = (o: Outcome) => {
    setOutcome(o);
    if (whenTouched || !retryDefault) return;
    setWhen(o === "NO_ANSWER" ? retryDefault.local : "");
  };
  const [declineReason, setDeclineReason] = useState("");
  const [pkg, setPkg] = useState(packages[0]?.key ?? "");
  const [deal, setDeal] = useState({ service: packages[0]?.label ?? "", oneTime: packages[0] ? String(packages[0].oneTimeCents / 100) : "", monthly: packages[0]?.monthlyCents ? String(packages[0].monthlyCents / 100) : "", startDate: today, offerId: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = !!outcome || note.trim().length > 0;

  useEffect(() => {
    if (!shortcuts || blockedReason) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) && (t as HTMLInputElement).type !== "radio") return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        e.preventDefault();
        // клик по радио бутона → същият път като с мишката (onChange → choose)
        const el = document.getElementById(`outcome-${businessId}-${OUTCOMES[n - 1]}`) as HTMLInputElement | null;
        el?.click();
        el?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shortcuts, blockedReason, businessId]);

  const needsConnected = outcome === "CALL_BACK" || outcome === "DO_NOT_CONTACT";
  const whenLabel = useMemo(() => {
    if (outcome === "CALL_BACK") return "Дата и час за обратно обаждане (задължително)";
    if (outcome === "NO_ANSWER") return retryDefault ? `Повторно обаждане — изчислено след ${retryDefault.workdays} работни дни; можеш да избереш друга дата` : "Повторно обаждане";
    if (outcome === "INTERESTED" || outcome === "SEND_OFFER") return "Следваща стъпка (по избор)";
    return null;
  }, [outcome, retryDefault]);

  async function submit() {
    if (!outcome) return setErr("Избери резултат.");
    setErr(null);
    const body: Record<string, unknown> = { businessId, outcome, idempotencyKey: key, note: note || undefined, channel: otherChannel ? "OTHER" : "PHONE" };
    if (needsConnected) {
      if (!connected) return setErr("Посочи дали е имало разговор.");
      body.callConnected = connected === "yes";
    }
    if (outcome === "CALL_BACK") {
      if (!when) return setErr("„Да се обадя отново“ изисква дата и час.");
      body.callbackAtLocal = when;
    }
    if (outcome === "NO_ANSWER" && when && (whenTouched || !retryDefault)) body.retryAtLocal = when;
    if ((outcome === "INTERESTED" || outcome === "SEND_OFFER") && when) body.nextStepAtLocal = when;
    if (outcome === "SEND_OFFER") body.offerDraft = { packageKey: pkg };
    if (outcome === "DECLINED") {
      if (!declineReason.trim()) return setErr("Посочи причина за отказа.");
      body.declineReason = declineReason;
    }
    if (outcome === "WON") {
      const one = toCents(deal.oneTime);
      const mon = toCents(deal.monthly);
      if (one === null || Number.isNaN(one)) return setErr("Въведи договорена еднократна сума (напр. 700 или 700,50).");
      if (Number.isNaN(mon)) return setErr("Невалидна месечна сума.");
      if (deal.service.trim().length < 2) return setErr("Въведи договорената услуга.");
      body.deal = { service: deal.service, oneTimeCents: one, monthlyCents: mon, startDate: deal.startDate, offerId: deal.offerId || undefined };
    }
    setBusy(true);
    const r = await callApi<{ stage: string; duplicate: boolean; retryAt?: string }>("/api/outcomes", body);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "Грешка при запис."); // ключът се пази → безопасен retry
    setSaved(
      `Записано: ${OUTCOME_LABELS[outcome]}${r.data?.duplicate ? " (вече беше записано — без дублиране)" : ""}.${r.data?.retryAt ? ` Повторно обаждане: ${fmtDateTime(r.data.retryAt)}.` : ""}`,
    );
    setKey(newKey());
    setOutcome(null);
    setNote("");
    setWhen("");
    setWhenTouched(false);
    setConnected("");
    setDeclineReason("");
    onSaved?.({ ...r.data!, outcome });
  }

  if (blockedReason) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm" role="status">
        <strong>Обажданията са блокирани.</strong> {blockedReason}
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <UnsavedGuard dirty={dirty} />
      <fieldset className="@container">
        <legend className="label">
          Резултат от разговора{shortcuts && <span className="ml-1 text-xs">(клавиши 1–9)</span>}
        </legend>
        <div className="grid grid-cols-2 gap-1.5 @lg:grid-cols-3">
          {OUTCOMES.map((o, i) => (
            <label key={o} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-blue-950/40 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-2 ${OUTCOME_TONE[o] ?? "border-line"}`}>
              <input id={`outcome-${businessId}-${o}`} type="radio" name={`outcome-${businessId}`} value={o} checked={outcome === o} onChange={() => choose(o)} className="h-4 w-4 shrink-0 accent-[#3b82f6]" />
              {shortcuts && <span className="tabular w-3 shrink-0 text-xs text-muted" aria-hidden>{i + 1}</span>}
              <span className="min-w-0 leading-tight font-medium break-words">{OUTCOME_LABELS[o]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {outcome && <p className="text-xs text-muted">{OUTCOME_HINTS[outcome]}</p>}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Какво прави всеки резултат?</summary>
        <dl className="mt-1 space-y-0.5">
          {OUTCOMES.map((o) => (
            <div key={o}>
              <dt className="inline font-medium text-fg">{OUTCOME_LABELS[o]}:</dt> <dd className="inline">{OUTCOME_HINTS[o]}</dd>
            </div>
          ))}
        </dl>
      </details>

      {needsConnected && (
        <fieldset>
          <legend className="label">Имаше ли реален разговор? (задължително)</legend>
          <div className="flex gap-4 text-sm">
            {(["yes", "no"] as const).map((v) => (
              <label key={v} className="flex items-center gap-2">
                <input type="radio" name={`conn-${businessId}`} checked={connected === v} onChange={() => setConnected(v)} className="h-4 w-4" />
                {v === "yes" ? "Да, говорихме" : "Не"}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {whenLabel && (
        <div>
          <label className="label" htmlFor={`when-${businessId}`}>
            {whenLabel} — българско време
          </label>
          <input id={`when-${businessId}`} type="datetime-local" className="field" value={when} onChange={(e) => {
              setWhen(e.target.value);
              setWhenTouched(true);
            }} required={outcome === "CALL_BACK"} />
        </div>
      )}

      {outcome === "SEND_OFFER" && (
        <div>
          <label className="label" htmlFor={`pkg-${businessId}`}>
            Пакет за черновата (примерни цени от Настройки)
          </label>
          <select id={`pkg-${businessId}`} className="field" value={pkg} onChange={(e) => setPkg(e.target.value)}>
            {packages.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">Създава се ЧЕРНОВА. Офертата не се изпраща от приложението.</p>
        </div>
      )}

      {outcome === "DECLINED" && (
        <div>
          <label className="label" htmlFor={`dr-${businessId}`}>
            Причина за отказа (задължително)
          </label>
          <input id={`dr-${businessId}`} className="field" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
        </div>
      )}

      {outcome === "WON" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor={`ds-${businessId}`}>
              Договорена услуга
            </label>
            <input id={`ds-${businessId}`} className="field" value={deal.service} onChange={(e) => setDeal({ ...deal, service: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`do-${businessId}`}>
              Еднократна сума (EUR)
            </label>
            <input id={`do-${businessId}`} inputMode="decimal" className="field" value={deal.oneTime} onChange={(e) => setDeal({ ...deal, oneTime: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`dm-${businessId}`}>
              Месечна поддръжка (EUR, по избор)
            </label>
            <input id={`dm-${businessId}`} inputMode="decimal" className="field" value={deal.monthly} onChange={(e) => setDeal({ ...deal, monthly: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor={`dd-${businessId}`}>
              Начало
            </label>
            <input id={`dd-${businessId}`} type="date" className="field" value={deal.startDate} onChange={(e) => setDeal({ ...deal, startDate: e.target.value })} />
          </div>
          {openOffers.length > 0 && (
            <div>
              <label className="label" htmlFor={`dof-${businessId}`}>
                Приета оферта
              </label>
              <select id={`dof-${businessId}`} className="field" value={deal.offerId} onChange={(e) => setDeal({ ...deal, offerId: e.target.value })}>
                <option value="">— без —</option>
                {openOffers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.service}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="text-xs text-muted sm:col-span-2">Създава клиент с договорени суми. Това НЕ е получено плащане — плащанията се записват ръчно в „Клиенти“.</p>
        </div>
      )}

      <div>
        <label className="label" htmlFor={`note-${businessId}`}>
          Бележка
        </label>
        <textarea id={`note-${businessId}`} className={`field ${compact ? "min-h-16" : "min-h-20"}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
      </div>
      <details className="text-sm text-muted" open={otherChannel}>
        <summary className="cursor-pointer text-xs">Още опции</summary>
        <label className="mt-1 flex items-center gap-2">
          <input type="checkbox" checked={otherChannel} onChange={(e) => setOtherChannel(e.target.checked)} className="h-4 w-4" />
          Контакт извън телефона (на място/имейл) — не се брои като обаждане
        </label>
      </details>
      {err && (
        <p role="alert" className="text-sm text-bad">
          {err}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-ok">
          {saved}
        </p>
      )}
      <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={busy || !outcome}>
        {busy ? "Записване…" : submitLabel}
      </button>
    </form>
  );
}
