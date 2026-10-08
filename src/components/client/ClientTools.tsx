"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi, newKey } from "./api";

export function PaymentForm({ clientId, today }: { clientId: string; today: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [key, setKey] = useState(newKey);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  return (
    <form
      className="rounded-md border border-line p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const s = amount.replace(/\s|€/g, "").replace(",", ".");
        if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) return setMsg({ ok: false, t: "Невалидна сума." });
        const r = await callApi(`/api/clients/${clientId}/payment`, { amountCents: Math.round(Number(s) * 100), receivedOn: date, note: note || undefined, idempotencyKey: key });
        if (!r.ok) return setMsg({ ok: false, t: r.error ?? "Грешка" });
        setMsg({ ok: true, t: "Плащането е записано." });
        setAmount("");
        setNote("");
        setKey(newKey());
        router.refresh();
      }}
    >
      <div className="mb-1 text-xs font-medium">Ръчно записано получено плащане</div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label className="label" htmlFor={`pa-${clientId}`}>
            Сума (EUR)
          </label>
          <input id={`pa-${clientId}`} className="field min-h-9 py-1 text-sm" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor={`pd-${clientId}`}>
            Дата
          </label>
          <input id={`pd-${clientId}`} type="date" className="field min-h-9 py-1 text-sm" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="col-span-2">
          <label className="label" htmlFor={`pn-${clientId}`}>
            Бележка
          </label>
          <input id={`pn-${clientId}`} className="field min-h-9 py-1 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-sm mt-2">Запиши плащане</button>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>
          {msg.t}
        </p>
      )}
    </form>
  );
}

export function ClientEditor({ id, status, nextAction, endDate }: { id: string; status: string; nextAction: string; endDate: string }) {
  const router = useRouter();
  const [f, setF] = useState({ status, nextAction, endDate });
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <form
      className="rounded-md border border-line p-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await callApi(`/api/clients/${id}/edit`, { status: f.status, nextAction: f.nextAction || null, endDate: f.endDate || null });
        setMsg(r.ok ? "Запазено." : (r.error ?? "Грешка"));
        router.refresh();
      }}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label className="label" htmlFor={`cs-${id}`}>
            Статус
          </label>
          <select id={`cs-${id}`} className="field min-h-9 py-1 text-sm" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="ACTIVE">Активен</option>
            <option value="PAUSED">Пауза</option>
            <option value="ENDED">Приключил</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`ce-${id}`}>
            Край
          </label>
          <input id={`ce-${id}`} type="date" className="field min-h-9 py-1 text-sm" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </div>
        <div className="col-span-2">
          <label className="label" htmlFor={`cn-${id}`}>
            Следващо действие
          </label>
          <input id={`cn-${id}`} className="field min-h-9 py-1 text-sm" value={f.nextAction} onChange={(e) => setF({ ...f, nextAction: e.target.value })} />
        </div>
      </div>
      <button className="btn btn-sm mt-2">Запази</button>
      {msg && (
        <p role="status" className="text-xs">
          {msg}
        </p>
      )}
    </form>
  );
}
