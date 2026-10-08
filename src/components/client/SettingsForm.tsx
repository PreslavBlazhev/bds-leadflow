"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Settings } from "@/domain/settings";
import { RULE_LABELS } from "@/domain/scoring";
import { WEEKDAY_LABELS } from "@/lib/time";
import { callApi } from "./api";

/** Редактируеми defaults. Валидация и в браузъра (HTML), и на сървъра (Zod). */
export function SettingsForm({ initial, knownCities }: { initial: Settings; knownCities: string[] }) {
  const router = useRouter();
  const [s, setS] = useState<Settings>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [otherInput, setOtherInput] = useState("");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const others = knownCities.filter((c) => !s.priorityCities.some((p) => p.name === c));

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        const r = await callApi("/api/settings", s, "PUT");
        setMsg(r.ok ? { ok: true, t: "Запазено. Промяна на часа влияе само на следващото изпълнение." } : { ok: false, t: r.error ?? "Грешка" });
        if (r.ok) router.refresh();
      }}
    >
      <fieldset className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="px-1 text-base font-semibold">Дневен план</legend>
        <div>
          <label className="label" htmlFor="s-target">
            Дневна цел (нови)
          </label>
          <input id="s-target" type="number" min={1} max={200} className="field" value={s.dailyTarget} onChange={(e) => set("dailyTarget", num(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="s-pub">
            Публикуване/известие (ЧЧ:ММ)
          </label>
          <input id="s-pub" type="time" className="field" value={s.publishTime} onChange={(e) => set("publishTime", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="s-prep">
            Подготовка (преди публикуването)
          </label>
          <input id="s-prep" type="time" className="field" value={s.prepareTime} onChange={(e) => set("prepareTime", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="s-res">
            Цел за резерв
          </label>
          <input id="s-res" type="number" min={0} className="field" value={s.reserveTarget} onChange={(e) => set("reserveTarget", num(e.target.value))} />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="label">Дни за нови списъци (по подразбиране понеделник–петък)</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_LABELS.map((l, i) => (
              <label key={l} className="flex items-center gap-1 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={s.activeWeekdays.includes(i + 1)} onChange={(e) => set("activeWeekdays", e.target.checked ? [...s.activeWeekdays, i + 1].sort() : s.activeWeekdays.filter((d) => d !== i + 1))} />
                {l}
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-sm mt-1" onClick={() => set("activeWeekdays", [1, 2, 3, 4, 5])}>
            Само работни дни (опция)
          </button>
        </fieldset>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="s-source">
            Източник на новите дневни списъци
          </label>
          <select id="s-source" className="field" value={s.leadSource} onChange={(e) => set("leadSource", e.target.value as Settings["leadSource"])}>
            <option value="REAL">Реални (импортирани) бизнеси — без демо записи</option>
            <option value="DEMO">Демо (синтетични) — само за упражнение</option>
          </select>
          <p className="mt-1 text-xs text-muted">Смяната не трие история и не публикува втори списък за деня. При „Реални“ демо генераторът и „следващ ден“ са изключени.</p>
        </div>
        <div className="space-y-1 text-sm sm:col-span-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={s.pauseNewLists} onChange={(e) => set("pauseNewLists", e.target.checked)} /> Пауза на новите списъци (follow-ups продължават)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={s.paused} onChange={(e) => set("paused", e.target.checked)} /> Пауза на цялата автоматизация
          </label>
          <div>
            <label className="label" htmlFor="s-backlog">
              Праг за предупреждение при много необработени контакти
            </label>
            <input id="s-backlog" type="number" className="field" value={s.backlogWarningThreshold} onChange={(e) => set("backlogWarningThreshold", num(e.target.value))} />
          </div>
        </div>
      </fieldset>

      <fieldset className="card space-y-3 p-3">
        <legend className="px-1 text-base font-semibold">Градове и квоти</legend>
        {s.priorityCities.map((c, i) => (
          <div key={c.name} className="flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={c.enabled} onChange={(e) => set("priorityCities", s.priorityCities.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
              {c.name} (приоритетен)
            </label>
            <div>
              <label className="label" htmlFor={`q-${i}`}>
                Квота
              </label>
              <input id={`q-${i}`} type="number" min={0} className="field w-24" value={c.quota} onChange={(e) => set("priorityCities", s.priorityCities.map((x, j) => (j === i ? { ...x, quota: num(e.target.value) } : x)))} />
            </div>
          </div>
        ))}
        <div>
          <div className="label">Други ИЗБРАНИ градове (квота {s.otherQuota}). Без избрани — местата се преразпределят към приоритетните. Без скрито национално разширяване.</div>
          <div className="flex flex-wrap gap-1.5">
            {s.otherCities.map((c) => (
              <button key={c} type="button" className="btn btn-sm" onClick={() => set("otherCities", s.otherCities.filter((x) => x !== c))} aria-label={`Премахни ${c}`}>
                {c} ✕
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="s-other">
                Добави град
              </label>
              <input id="s-other" list="known-cities" className="field w-48" value={otherInput} onChange={(e) => setOtherInput(e.target.value)} />
              <datalist id="known-cities">
                {others.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const v = otherInput.trim();
                if (v && !s.otherCities.includes(v) && !s.priorityCities.some((p) => p.name === v)) set("otherCities", [...s.otherCities, v]);
                setOtherInput("");
              }}
            >
              Добави
            </button>
            <div>
              <label className="label" htmlFor="s-oq">
                Квота „други“
              </label>
              <input id="s-oq" type="number" min={0} className="field w-24" value={s.otherQuota} onChange={(e) => set("otherQuota", num(e.target.value))} />
            </div>
          </div>
        </div>
        <fieldset>
          <legend className="label">Категории</legend>
          <div className="flex flex-wrap gap-3">
            {s.categories.map((c, i) => (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={c.enabled} onChange={(e) => set("categories", s.categories.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>

      <fieldset className="card grid gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5">
        <legend className="px-1 text-base font-semibold">Score тегла (правила, без AI)</legend>
        {(Object.keys(s.scoreWeights) as (keyof Settings["scoreWeights"])[]).map((k) => (
          <div key={k}>
            <label className="label" htmlFor={`w-${k}`}>
              {RULE_LABELS[k]}
            </label>
            <input id={`w-${k}`} type="number" min={-100} max={100} className="field" value={s.scoreWeights[k]} onChange={(e) => set("scoreWeights", { ...s.scoreWeights, [k]: num(e.target.value) })} />
          </div>
        ))}
      </fieldset>

      <fieldset className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="px-1 text-base font-semibold">Обаждания и известия</legend>
        <div>
          <label className="label" htmlFor="retry-days">
            Повторно обаждане при липса на отговор
          </label>
          <select id="retry-days" className="field" value={s.noAnswerRetryWorkdays} onChange={(e) => set("noAnswerRetryWorkdays", Number(e.target.value) === 3 ? 3 : 2)}>
            <option value={2}>след 2 работни дни</option>
            <option value={3}>след 3 работни дни</option>
          </select>
          <p className="mt-1 text-xs text-muted">Работни дни: понеделник–петък. Напр. при 2: пн → ср, чт → пн, пт → вт. Във формата за резултат можеш да избереш друга дата.</p>
        </div>
        <div>
          <label className="label" htmlFor="wd-start">
            Начало на работния ден (час на повторните обаждания)
          </label>
          <input id="wd-start" type="time" className="field" value={s.workdayStart} onChange={(e) => set("workdayStart", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cw-s">
            Служебен прозорец от
          </label>
          <input id="cw-s" type="time" className="field" value={s.callWindow.start} onChange={(e) => set("callWindow", { ...s.callWindow, start: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="cw-e">
            до
          </label>
          <input id="cw-e" type="time" className="field" value={s.callWindow.end} onChange={(e) => set("callWindow", { ...s.callWindow, end: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="fb">
            Fallback имейл след (мин.)
          </label>
          <input id="fb" type="number" min={5} className="field" value={s.notifications.fallbackDelayMinutes} onChange={(e) => set("notifications", { ...s.notifications, fallbackDelayMinutes: num(e.target.value) })} />
        </div>
        <div className="space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={s.notifications.pushEnabled} onChange={(e) => set("notifications", { ...s.notifications, pushEnabled: e.target.checked })} /> Push
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" checked={s.notifications.emailFallbackEnabled} onChange={(e) => set("notifications", { ...s.notifications, emailFallbackEnabled: e.target.checked })} /> Резервен имейл
          </label>
        </div>
      </fieldset>

      <fieldset className="card space-y-2 p-3">
        <legend className="px-1 text-base font-semibold">Пакети и цени (примерни, редактируеми)</legend>
        {s.packages.map((p, i) => (
          <div key={p.key} className="grid gap-2 sm:grid-cols-[1fr_9rem_9rem]">
            <div>
              <label className="label" htmlFor={`pk-l-${i}`}>
                Пакет
              </label>
              <input id={`pk-l-${i}`} className="field" value={p.label} onChange={(e) => set("packages", s.packages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </div>
            <div>
              <label className="label" htmlFor={`pk-o-${i}`}>
                Еднократно (EUR)
              </label>
              <input id={`pk-o-${i}`} type="number" min={0} step="0.01" className="field" value={p.oneTimeCents / 100} onChange={(e) => set("packages", s.packages.map((x, j) => (j === i ? { ...x, oneTimeCents: Math.round(Number(e.target.value) * 100) } : x)))} />
            </div>
            <div>
              <label className="label" htmlFor={`pk-m-${i}`}>
                Месечно (EUR)
              </label>
              <input id={`pk-m-${i}`} type="number" min={0} step="0.01" className="field" value={(p.monthlyCents ?? 0) / 100} onChange={(e) => set("packages", s.packages.map((x, j) => (j === i ? { ...x, monthlyCents: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) } : x)))} />
            </div>
          </div>
        ))}
        <p className="text-xs text-muted">Началните стойности са примерни — не обещават актуален ценоразпис.</p>
      </fieldset>

      <fieldset className="card p-3">
        <legend className="px-1 text-base font-semibold">Retention бележки</legend>
        <label className="label" htmlFor="ret">
          Политика (описателно)
        </label>
        <textarea id="ret" className="field" value={s.retentionNotes} onChange={(e) => set("retentionNotes", e.target.value)} />
      </fieldset>

      <div className="sticky bottom-16 flex items-center gap-3 md:bottom-2">
        <button className="btn btn-primary">Запази настройките</button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-bad"}`}>
            {msg.t}
          </span>
        )}
      </div>
    </form>
  );
}
