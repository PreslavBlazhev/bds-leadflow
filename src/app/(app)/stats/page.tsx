import Link from "next/link";
import { money, Notice, PageHeader, Stat, StateBadge } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABELS } from "@/domain/constants";
import { computeStats, statsByCategory } from "@/domain/stats";
import { requirePageOwner } from "@/lib/server";
import { addDays, fmtDate, isLocalDate, localDateOf } from "@/lib/time";

export const metadata = { title: "Статистика" };

const pct = (v: number | null) => (v === null ? "недостатъчно данни" : `${(v * 100).toFixed(0)}%`);

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; city?: string; category?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/stats");
  const today = localDateOf(ctx.clock.now());
  const to = sp.to && isLocalDate(sp.to) ? sp.to : today;
  const from = sp.from && isLocalDate(sp.from) ? sp.from : addDays(to, -29);
  const filter = { from, to, city: sp.city || undefined, category: sp.category || undefined };
  const [s, byCat, cities] = await Promise.all([computeStats(ctx.db, filter), statsByCategory(ctx.db, filter), ctx.db.business.findMany({ distinct: ["city"], select: { city: true }, orderBy: { city: "asc" } })]);
  const preset = (days: number) => `/stats?from=${addDays(today, -(days - 1))}&to=${today}${sp.city ? `&city=${sp.city}` : ""}${sp.category ? `&category=${sp.category}` : ""}`;
  const c = s.counts;
  return (
    <>
      <PageHeader title="Статистика" sub={`${fmtDate(from)} – ${fmtDate(to)} · изчислено от базата`} state={ctx.mode === "demo" ? <StateBadge state="DEMO_SIMULATED" title="От демо действия и seed история" /> : <StateBadge state="WORKING_LOCAL" />} />
      <form method="get" className="card mb-4 grid grid-cols-2 gap-2 p-3 md:grid-cols-5">
        <div>
          <label className="label" htmlFor="s-from">
            От
          </label>
          <input id="s-from" type="date" name="from" defaultValue={from} className="field min-h-9 py-1 text-sm" />
        </div>
        <div>
          <label className="label" htmlFor="s-to">
            До
          </label>
          <input id="s-to" type="date" name="to" defaultValue={to} className="field min-h-9 py-1 text-sm" />
        </div>
        <div>
          <label className="label" htmlFor="s-city">
            Град
          </label>
          <select id="s-city" name="city" defaultValue={sp.city ?? ""} className="field min-h-9 py-1 text-sm">
            <option value="">Всички</option>
            {cities.map((x) => (
              <option key={x.city}>{x.city}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="s-cat">
            Категория
          </label>
          <select id="s-cat" name="category" defaultValue={sp.category ?? ""} className="field min-h-9 py-1 text-sm">
            <option value="">Всички</option>
            {CATEGORIES.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-1">
          <button className="btn btn-primary btn-sm">Приложи</button>
          <Link className="btn btn-sm" href={preset(7)}>
            7 дни
          </Link>
          <Link className="btn btn-sm" href={preset(90)}>
            90 дни
          </Link>
        </div>
      </form>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Новоразпределени" value={c.assigned} />
        <Stat label="Записани опити" value={c.attempts} hint="CALL записи" />
        <Stat label="Реални разговори" value={c.conversations} hint="callConnected = да" />
        <Stat label="Заинтересовани" value={c.interested} hint="различни бизнеси" />
        <Stat label="Срещи" value={c.meetings} hint="само активност Среща" />
        <Stat label="Оферти (създадени)" value={c.offersCreated} />
        <Stat label="Оферти (изпратени ръчно)" value={c.offersSent} />
        <Stat label="Спечелени" value={c.won} />
        <Stat label="Договорено еднократно" value={money(s.money.agreedOneTimeCents)} hint={`+ ${money(s.money.agreedMonthlyCents)}/мес.`} />
        <Stat label="Получено (ръчно записано)" value={money(s.money.receivedCents)} hint={`${c.paymentsCount} плащания`} />
      </div>

      <h2 className="mb-2 text-base font-semibold">Конверсии и дефиниции</h2>
      <div className="mb-4 overflow-x-auto">
        <table className="data card">
          <thead>
            <tr>
              <th>Показател</th>
              <th>Стойност</th>
              <th>Числител / знаменател</th>
              <th>Дефиниция</th>
            </tr>
          </thead>
          <tbody>
            {s.rates.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="tabular">
                  {pct(r.value)}
                  {r.sample === "small" && <span className="ml-1 text-xs text-warn">▲ малка извадка</span>}
                </td>
                <td className="tabular">
                  {r.num} / {r.den}
                </td>
                <td className="text-xs text-muted">{r.definition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.rates.some((r) => r.sample !== "ok") && <Notice tone="info">При знаменател под 30 не правим изводи от типа „този сектор е най-печеливш“. Контакти извън телефона в периода: {c.otherContacts} (не се броят като опити).</Notice>}

      <h2 className="mt-4 mb-2 text-base font-semibold">По категории</h2>
      <div className="overflow-x-auto">
        <table className="data card">
          <thead>
            <tr>
              <th>Категория</th>
              <th>Разпределени</th>
              <th>Опити</th>
              <th>Разговори</th>
              <th>Заинтересовани</th>
              <th>Спечелени</th>
            </tr>
          </thead>
          <tbody>
            {byCat.map((r) => (
              <tr key={r.category}>
                <td>{CATEGORY_LABELS[r.category]}</td>
                <td className="tabular">{r.assigned}</td>
                <td className="tabular">{r.attempts}</td>
                <td className="tabular">{r.conversations}</td>
                <td className="tabular">{r.interested}</td>
                <td className="tabular">{r.won}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
