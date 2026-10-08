"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { callApi } from "./api";

interface Preview {
  headers: string[];
  mapping: Record<string, string>;
  plans: { row: number; action: string; message: string; name: string; city: string }[];
  counts: Record<string, number>;
  totalRows: number;
}

const ACTION_LABEL: Record<string, string> = { create: "Нов", duplicate: "Дубликат", conflict: "Конфликт", skip: "Пропуснат" };

export function ImportWizard({ fields }: { fields: string[] }) {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState(false);
  const [neverContacted, setNeverContacted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function runPreview(text: string, m?: Record<string, string>) {
    setBusy(true);
    setErr(null);
    const r = await callApi<Preview>("/api/import/preview", { text, mapping: m });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "Грешка");
    setPreview(r.data!);
    setMapping(r.data!.mapping);
  }

  return (
    <div className="space-y-4">
      <div className="card p-3">
        <label className="label" htmlFor="csv-file">
          CSV файл
        </label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          className="text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setPreview(null);
            setDone(null);
            if (!f) return;
            if (f.size > 2_000_000) return setErr("Файлът е по-голям от 2 MB.");
            const text = await f.text();
            setFile({ name: f.name, text });
            await runPreview(text);
          }}
        />
      </div>
      {err && (
        <p role="alert" className="text-sm text-bad">
          {err}
        </p>
      )}
      {preview && file && (
        <>
          <div className="card p-3">
            <h2 className="mb-2 text-sm font-semibold">Mapping на колоните</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {fields.map((f) => (
                <div key={f}>
                  <label className="label" htmlFor={`map-${f}`}>
                    {f}
                  </label>
                  <select id={`map-${f}`} className="field min-h-9 py-1 text-sm" value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value })}>
                    <option value="">— не се импортира —</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-sm mt-3" disabled={busy} onClick={() => runPreview(file.text, Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))}>
              Обнови preview
            </button>
          </div>
          <div className="card p-3">
            <h2 className="mb-1 text-sm font-semibold">Preview ({preview.totalRows} реда) — нищо не е записано</h2>
            <p className="text-sm">
              Нови: {preview.counts.create} · Дубликати: {preview.counts.duplicate} · Конфликти (за проверка): {preview.counts.conflict} · Пропуснати: {preview.counts.skip}
            </p>
            <div className="mt-2 max-h-80 overflow-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Ред</th>
                    <th>Действие</th>
                    <th>Бизнес</th>
                    <th>Бележка</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plans.map((p) => (
                    <tr key={p.row}>
                      <td className="tabular">{p.row}</td>
                      <td>{ACTION_LABEL[p.action]}</td>
                      <td>
                        {p.name} {p.city && <span className="text-muted">· {p.city}</span>}
                      </td>
                      <td className="text-xs text-muted">{p.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card space-y-2 p-3 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={usage} onChange={(e) => setUsage(e.target.checked)} />
              <span>Потвърждавам, че имам право да използвам и съхранявам тези служебни данни (provenance: „{file.name}“).</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={neverContacted} onChange={(e) => setNeverContacted(e.target.checked)} />
              <span>Проверено е, че НИТО ЕДИН ред без история не е контактуван преди (записва се в audit). Без отметка — неизвестна история, извън новите.</span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!usage || busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                const r = await callApi<{ counts: Record<string, number> }>("/api/import/commit", {
                  filename: file.name,
                  text: file.text,
                  mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
                  usageConfirmed: usage,
                  confirmNeverContacted: neverContacted,
                });
                setBusy(false);
                if (!r.ok) return setErr(r.error ?? "Грешка");
                const c = r.data!.counts;
                setDone(`Импортът е записан: създадени ${c.created}, дубликати ${c.duplicate}, конфликти ${c.conflict}, пропуснати ${c.skipped}.`);
                setPreview(null);
                router.refresh();
              }}
            >
              Импортирай
            </button>
            {!usage && <p className="text-xs text-muted">Недостъпно: потвърди правото за използване.</p>}
          </div>
        </>
      )}
      {done && (
        <p role="status" className="text-sm text-ok">
          {done}
        </p>
      )}
    </div>
  );
}
