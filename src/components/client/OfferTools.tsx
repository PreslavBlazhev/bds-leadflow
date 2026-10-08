"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton } from "./ActionButton";
import { callApi } from "./api";
import type { PackageOpt } from "./OutcomeForm";

const toCents = (v: string) => {
  const s = v.replace(/\s|€/g, "").replace(",", ".");
  if (!s) return null;
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
};

export function OfferEditor({ businesses, defaultBusinessId, packages, today, defaultValidUntil }: { businesses: { id: string; name: string; city: string }[]; defaultBusinessId?: string; packages: PackageOpt[]; today: string; defaultValidUntil: string }) {
  const router = useRouter();
  const first = packages[0];
  const [f, setF] = useState({
    businessId: defaultBusinessId ?? "",
    service: first?.label ?? "",
    oneTime: first ? String(first.oneTimeCents / 100) : "",
    monthly: first?.monthlyCents ? String(first.monthlyCents / 100) : "",
    description: "",
    offerDate: today,
    validUntil: defaultValidUntil,
    notes: "",
    nextStep: "Изпрати офертата и се обади след 3 дни",
  });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  if (businesses.length === 0) return <p className="text-sm text-muted">Няма контакти в етапи Контактуван/Квалифициран/Оферта. Оферта може да се създаде и от детайлите на контакт.</p>;
  return (
    <form
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const one = toCents(f.oneTime);
        const mon = toCents(f.monthly);
        if (one === null || Number.isNaN(one)) return setErr("Невалидна еднократна сума.");
        if (Number.isNaN(mon)) return setErr("Невалидна месечна сума.");
        setErr(null);
        const r = await callApi("/api/offers", { businessId: f.businessId, service: f.service, oneTimeCents: one, monthlyCents: mon, description: f.description, offerDate: f.offerDate, validUntil: f.validUntil || null, notes: f.notes || null, nextStep: f.nextStep || null });
        if (!r.ok) return setErr(r.error ?? "Грешка");
        setOk("Черновата е създадена.");
        router.refresh();
      }}
    >
      <div className="sm:col-span-2">
        <label className="label" htmlFor="o-biz">
          Клиент
        </label>
        <select id="o-biz" className="field" required value={f.businessId} onChange={(e) => setF({ ...f, businessId: e.target.value })}>
          <option value="">— избери —</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.city ? ` (${b.city})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="o-pkg">
          Пакет (попълва полетата; цените са примерни)
        </label>
        <select
          id="o-pkg"
          className="field"
          onChange={(e) => {
            const p = packages.find((x) => x.key === e.target.value);
            if (p) setF({ ...f, service: p.label, oneTime: String(p.oneTimeCents / 100), monthly: p.monthlyCents ? String(p.monthlyCents / 100) : "" });
          }}
        >
          {packages.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="o-svc">
          Услуга/пакет
        </label>
        <input id="o-svc" className="field" required value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="o-one">
          Еднократна сума (EUR)
        </label>
        <input id="o-one" className="field" inputMode="decimal" required value={f.oneTime} onChange={(e) => setF({ ...f, oneTime: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="o-mon">
          Месечна поддръжка (EUR)
        </label>
        <input id="o-mon" className="field" inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="o-date">
          Дата
        </label>
        <input id="o-date" type="date" className="field" value={f.offerDate} onChange={(e) => setF({ ...f, offerDate: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="o-valid">
          Валидна до
        </label>
        <input id="o-valid" type="date" className="field" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="o-next">
          Следваща стъпка
        </label>
        <input id="o-next" className="field" value={f.nextStep} onChange={(e) => setF({ ...f, nextStep: e.target.value })} />
      </div>
      <div className="sm:col-span-2 lg:col-span-4">
        <label className="label" htmlFor="o-desc">
          Описание
        </label>
        <textarea id="o-desc" className="field" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div className="sm:col-span-2 lg:col-span-4">
        <label className="label" htmlFor="o-notes">
          Бележки
        </label>
        <textarea id="o-notes" className="field" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
      {err && (
        <p role="alert" className="text-sm text-bad sm:col-span-2">
          {err}
        </p>
      )}
      {ok && (
        <p role="status" className="text-sm text-ok sm:col-span-2">
          {ok}
        </p>
      )}
      <div className="sm:col-span-2 lg:col-span-4">
        <button className="btn btn-primary">Създай чернова</button>
      </div>
    </form>
  );
}

export function OfferStatusActions({ id, status, dnc }: { id: string; status: string; dnc: boolean }) {
  if (status !== "DRAFT" && status !== "SENT") return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {status === "DRAFT" && (
        <ActionButton url={`/api/offers/${id}/status`} body={{ status: "SENT" }} className="btn btn-sm btn-primary" disabledReason={dnc ? "DNC — неизпратените оферти не се изпращат" : null}>
          Маркирай като изпратена (ръчно)
        </ActionButton>
      )}
      <ActionButton url={`/api/offers/${id}/status`} body={{ status: "ACCEPTED" }} className="btn btn-sm">
        Приета
      </ActionButton>
      <ActionButton url={`/api/offers/${id}/status`} body={{ status: "REJECTED" }} className="btn btn-sm">
        Отказана
      </ActionButton>
      <ActionButton url={`/api/offers/${id}/status`} body={{ status: "EXPIRED" }} className="btn btn-sm">
        Изтекла
      </ActionButton>
    </div>
  );
}
