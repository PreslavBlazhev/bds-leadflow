import type { PrismaClient } from "@prisma/client";
import type { Mode } from "@/lib/db";
import { addDays, localDateOf, weekdayOf, zonedToUtc } from "@/lib/time";
import { previewSelection } from "./batch";
import { buildEligibilityCtx, eligiblePool } from "./eligibility";
import { getSettings } from "./settings";
import { activeList, nextListDate } from "./activeList";

/**
 * Запас от реални кандидати и кога започва реалният дневен режим. Само четене — нищо не се резервира.
 * Изчерпване: колко дни по целта стигат допустимите и кога изтича свежестта на проверката (reserveFreshnessDays).
 */
export async function realStockSummary(db: PrismaClient, mode: Mode, now: Date) {
  const s = await getSettings(db);
  const ectx = await buildEligibilityCtx(db, mode, s, now);
  const pool = await eligiblePool(db, ectx);
  const real = pool.filter((c) => !c.b.isDemo);
  const today = localDateOf(now);

  // Следващ нов списък по правилата за активен списък (null = след приключване на активния).
  const active = await activeList(db, { realOnly: true });
  const next = await nextListDate(db, s, now, true);
  const firstDate = next?.localDate ?? null;
  const firstAt = firstDate ? zonedToUtc(firstDate, s.publishTime) : null;

  // Свежест: кандидат е допустим, докато now - verifiedAt ≤ reserveFreshnessDays.
  const freshMs = s.reserveFreshnessDays * 86_400_000;
  const expiries = real.map((c) => (c.b.verifiedAt ? c.b.verifiedAt.getTime() + freshMs : 0)).sort((a, b) => a - b);
  const firstExpiry = expiries.length ? new Date(expiries[0]!) : null;

  // Симулация „по целта на ден“ с отчитане на свежестта (без запис): колко списъка и колко остават неизползвани.
  const days: { localDate: string; count: number }[] = [];
  let left = [...real];
  // Оценка на запаса: от следващия възможен ден (или от утре, ако приключиш активния днес), само в дните за списъци.
  const simStart = firstDate ?? addDays(today, 1);
  {
    for (let i = 0; i < 90 && left.length > 0; i++) {
      const d = addDays(simStart, i);
      if (!s.activeWeekdays.includes(weekdayOf(d))) continue;
      const at = zonedToUtc(d, s.publishTime).getTime();
      left = left.filter((c) => c.b.verifiedAt && at - c.b.verifiedAt.getTime() <= freshMs);
      if (left.length === 0) break;
      const take = Math.min(s.dailyTarget, left.length);
      days.push({ localDate: d, count: take });
      left = left.slice(take);
    }
  }
  const usable = days.reduce((a, d) => a + d.count, 0);

  const byPriority: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const c of real) {
    byPriority[c.b.callPriority ?? "—"] = (byPriority[c.b.callPriority ?? "—"] ?? 0) + 1;
    byCategory[c.b.category] = (byCategory[c.b.category] ?? 0) + 1;
  }
  const previewDate = firstDate ?? days[0]?.localDate ?? null;
  const previewAt = previewDate ? zonedToUtc(previewDate, s.publishTime) : null;
  const preview = previewDate ? await previewSelection(db, mode, previewAt && previewAt > now ? previewAt : now, previewDate) : null;
  return {
    leadSource: s.leadSource,
    activeRemaining: active.remaining,
    previewDate,
    eligible: real.length,
    target: s.dailyTarget,
    byPriority,
    byCategory,
    firstDate,
    firstAt,
    publishTime: s.publishTime,
    freshnessDays: s.reserveFreshnessDays,
    firstExpiry,
    plannedDays: days,
    usableBeforeStale: usable,
    staleUnused: real.length - usable,
    fullDays: Math.floor(real.length / s.dailyTarget),
    preview,
  };
}
