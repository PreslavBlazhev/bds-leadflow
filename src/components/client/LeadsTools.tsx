"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { CATEGORIES } from "@/domain/constants";
import { callApi } from "./api";
import { Dialog } from "./Dialog";

const KEY = "lf.savedFilters";
function readSaved(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}
function subscribeStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener("lf-saved-filters", cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener("lf-saved-filters", cb);
  };
}

/** Запазени филтри — само локална UI настройка (query string), без лични данни. Контактите са в DB. */
export function SavedFilters() {
  const raw = useSyncExternalStore(subscribeStorage, readSaved, () => "[]");
  const saved = useMemo<{ name: string; qs: string }[]>(() => {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }, [raw]);
  const persist = (v: { name: string; qs: string }[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
      window.dispatchEvent(new Event("lf-saved-filters"));
    } catch {
      /* private mode — филтрите просто не се пазят */
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-sm">
      <span className="text-muted">Запазени филтри:</span>
      {saved.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1">
          <a href={`/leads?${s.qs}`} className="btn btn-sm">
            {s.name}
          </a>
          <button type="button" className="btn btn-sm" aria-label={`Изтрий филтър ${s.name}`} onClick={() => persist(saved.filter((x) => x.name !== s.name))}>
            ✕
          </button>
        </span>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const p = new URLSearchParams(window.location.search);
          p.delete("id");
          p.delete("page");
          p.delete("q"); // търсенето може да съдържа име — не се пази
          const name = `Филтър ${saved.length + 1}`;
          persist([...saved.filter((x) => x.name !== name), { name, qs: p.toString() }]);
        }}
      >
        Запази текущия
      </button>
    </div>
  );
}

export function AddLeadButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Добави ръчно
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Ръчно добавяне на бизнес" wide>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const body = {
              name: f.get("name"),
              city: f.get("city"),
              category: f.get("category"),
              phone: f.get("phone") || undefined,
              website: f.get("website") || undefined,
              socialUrl: f.get("socialUrl") || undefined,
              address: f.get("address") || undefined,
              notes: f.get("notes") || undefined,
              contactHistoryState: f.get("history"),
              usageConfirmed: f.get("usage") === "on",
              sourceNote: f.get("sourceNote"),
            };
            setErr(null);
            const r = await callApi<{ kind: string; businessId: string; review?: boolean; reason?: string }>("/api/leads", body);
            if (!r.ok) return setErr(r.error ?? "Грешка");
            const d = r.data!;
            setResult(d.kind === "existing" ? `Вече съществува (${d.reason}) — нищо не е създадено.` : d.review ? `Създаден, но е в проверка за дубликат: ${d.reason}` : "Създаден.");
            router.push(`/leads?tab=all&id=${d.businessId}`);
            router.refresh();
          }}
        >
          <div>
            <label className="label" htmlFor="m-name">
              Име *
            </label>
            <input id="m-name" name="name" className="field" required minLength={2} />
          </div>
          <div>
            <label className="label" htmlFor="m-city">
              Град *
            </label>
            <input id="m-city" name="city" className="field" required />
          </div>
          <div>
            <label className="label" htmlFor="m-cat">
              Категория *
            </label>
            <select id="m-cat" name="category" className="field">
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="m-phone">
              Служебен телефон
            </label>
            <input id="m-phone" name="phone" className="field" inputMode="tel" />
          </div>
          <div>
            <label className="label" htmlFor="m-web">
              Сайт
            </label>
            <input id="m-web" name="website" className="field" />
          </div>
          <div>
            <label className="label" htmlFor="m-social">
              Социална връзка
            </label>
            <input id="m-social" name="socialUrl" className="field" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="m-addr">
              Адрес
            </label>
            <input id="m-addr" name="address" className="field" />
          </div>
          <div>
            <label className="label" htmlFor="m-hist">
              История на контакт *
            </label>
            <select id="m-hist" name="history" className="field" defaultValue="UNKNOWN">
              <option value="UNKNOWN">Неизвестна (извън новите до потвърждение)</option>
              <option value="NONE_CONFIRMED">Потвърдено: никога не е контактуван</option>
              <option value="HAS_HISTORY">Има история</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="m-src">
              Източник (откъде е информацията) *
            </label>
            <input id="m-src" name="sourceNote" className="field" required minLength={2} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="m-notes">
              Бележки
            </label>
            <textarea id="m-notes" name="notes" className="field" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="usage" className="h-4 w-4" required /> Потвърждавам, че имам право да използвам и съхранявам тези служебни данни.
          </label>
          {err && (
            <p role="alert" className="text-sm text-bad sm:col-span-2">
              {err}
            </p>
          )}
          {result && (
            <p role="status" className="text-sm text-ok sm:col-span-2">
              {result}
            </p>
          )}
          <div className="sm:col-span-2">
            <button className="btn btn-primary">Добави</button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
