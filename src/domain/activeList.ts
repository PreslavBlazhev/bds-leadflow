import type { Prisma } from "@prisma/client";
import type { DbLike, Mode } from "@/lib/db";
import { addDays, localDateOf, weekdayOf, zonedToUtc } from "@/lib/time";
import { dataMode, type Settings } from "./settings";

/**
 * Активен списък и условия за следващ (реален режим).
 * Контакт от списък е обработен, когато има успешно записан резултат (DailyBatchItem.processedAt — устойчиво).
 * Затворени по друг път записи (слят, архивиран/затворен, DNC) не блокират — по тях няма какво да се звъни.
 * Пропускане, отваряне на карта и „Позвъни“ не са обработване.
 */

/* ---------------- Работни дни ---------------- */

/** Работни дни за повторни обаждания: понеделник–петък (Europe/Sofia). */
export const isWorkday = (localDate: string) => weekdayOf(localDate) <= 5;

export function addWorkdays(localDate: string, n: number): string {
  let d = localDate;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkday(d)) left--;
  }
  return d;
}

/** „Не отговори“ → повторно обаждане след N работни дни в началото на работния ден. */
export function noAnswerRetryAt(now: Date, s: Pick<Settings, "noAnswerRetryWorkdays" | "workdayStart">): Date {
  return zonedToUtc(addWorkdays(localDateOf(now), s.noAnswerRetryWorkdays), s.workdayStart);
}

/* ---------------- Активен списък ---------------- */

/** Участие, което още чака резултат: без processedAt и бизнесът е отворен за обаждане. */
export const PENDING_ITEM: Prisma.DailyBatchItemWhereInput = {
  processedAt: null,
  business: { status: "ACTIVE", mergedIntoId: null, suppressions: { none: { liftedAt: null, type: "DNC" } } },
};

export const realOnlyFor = (mode: Mode, s: Pick<Settings, "leadSource">) => dataMode(mode, s) === "real";

export interface ActiveList {
  /** Списъци с поне един необработен контакт (обикновено един), най-старият първи. */
  batches: { id: string; localDate: string; total: number; handled: number; remaining: number }[];
  total: number;
  handled: number;
  remaining: number;
  /** Необработените контакти по ред: дата на списъка, позиция. */
  pending: { businessId: string; localDate: string; position: number }[];
}

export async function activeList(db: DbLike, opts: { realOnly: boolean }): Promise<ActiveList> {
  const demoFilter: Prisma.DailyBatchItemWhereInput = opts.realOnly ? { business: { isDemo: false } } : {};
  const pending = await db.dailyBatchItem.findMany({
    where: { AND: [PENDING_ITEM, demoFilter] },
    select: { businessId: true, position: true, batchId: true, batch: { select: { localDate: true } } },
    orderBy: [{ batch: { localDate: "asc" } }, { position: "asc" }],
  });
  const ids = [...new Set(pending.map((p) => p.batchId))];
  const batches: ActiveList["batches"] = [];
  for (const id of ids) {
    const total = await db.dailyBatchItem.count({ where: { AND: [{ batchId: id }, demoFilter] } });
    const remaining = pending.filter((p) => p.batchId === id).length;
    batches.push({ id, localDate: pending.find((p) => p.batchId === id)!.batch.localDate, total, handled: total - remaining, remaining });
  }
  batches.sort((a, b) => (a.localDate < b.localDate ? -1 : 1));
  const total = batches.reduce((a, b) => a + b.total, 0);
  return {
    batches,
    total,
    handled: batches.reduce((a, b) => a + b.handled, 0),
    remaining: pending.length,
    pending: pending.map((p) => ({ businessId: p.businessId, localDate: p.batch.localDate, position: p.position })),
  };
}

export type GateCode = "PAUSED" | "NOT_WORKDAY" | "BEFORE_TIME" | "ACTIVE_LIST" | "NO_CANDIDATES";

export interface Gate {
  ok: boolean;
  code?: GateCode;
  reason?: string;
  /** брой необработени контакти, които блокират (при ACTIVE_LIST) */
  blocking?: number;
}

/**
 * Може ли да се създаде (или допълни) нов списък за localDate — реален режим. Еднакво за worker, ръчни действия и UI.
 *  - само в дните за нови списъци (по подразбиране пн–пт);
 *  - нов списък — само след часа за публикуване;
 *  - всички контакти от предишни списъци трябва да са обработени ДО часа за публикуване на тази дата:
 *    ако в 08:00 е имало необработени, за този ден нов списък няма — дори да ги приключиш по-късно същия ден.
 * Допустимите кандидати се проверяват отделно при подбора (NO_CANDIDATES).
 */
export async function newListGate(db: DbLike, s: Settings, localDate: string, now: Date, opts: { existing: boolean; realOnly: boolean }): Promise<Gate> {
  if (!opts.existing && (s.paused || s.pauseNewLists)) return { ok: false, code: "PAUSED", reason: "Новите списъци са на пауза." };
  if (!opts.realOnly) return { ok: true };
  if (!s.activeWeekdays.includes(weekdayOf(localDate))) {
    return { ok: false, code: "NOT_WORKDAY", reason: "Днес не е ден за нови списъци (по подразбиране само понеделник–петък). Активният списък и обажданията остават достъпни." };
  }
  const publishAt = zonedToUtc(localDate, s.publishTime);
  if (!opts.existing && now < publishAt) return { ok: false, code: "BEFORE_TIME", reason: `Новият списък се издава след ${s.publishTime}.` };
  const blocking = await db.dailyBatchItem.count({
    where: {
      batch: { localDate: { lt: localDate } },
      business: { isDemo: false },
      OR: [PENDING_ITEM, { processedAt: { gt: publishAt } }],
    },
  });
  if (blocking > 0) {
    const stillOpen = await db.dailyBatchItem.count({ where: { AND: [PENDING_ITEM, { batch: { localDate: { lt: localDate } } }, { business: { isDemo: false } }] } });
    return {
      ok: false,
      code: "ACTIVE_LIST",
      blocking: stillOpen,
      reason:
        stillOpen > 0
          ? `Активният списък не е приключен: остават ${stillOpen} контакта без записан резултат. Следващият списък се издава след приключването им, в следващия работен ден в ${s.publishTime}.`
          : `Предишният списък беше приключен след ${s.publishTime} днес. Следващият списък се издава в следващия работен ден в ${s.publishTime}.`,
    };
  }
  return { ok: true };
}

/** Следващата дата за нов списък според текущото състояние (за показване). null = след приключване на активния. */
export async function nextListDate(db: DbLike, s: Settings, now: Date, realOnly: boolean): Promise<{ localDate: string; at: Date } | null> {
  const today = localDateOf(now);
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    if (!s.activeWeekdays.includes(weekdayOf(d))) continue;
    if (await db.dailyBatch.findUnique({ where: { localDate: d }, select: { id: true } })) continue;
    const at = zonedToUtc(d, s.publishTime);
    const g = await newListGate(db, s, d, at > now ? at : now, { existing: false, realOnly });
    if (g.ok) return { localDate: d, at };
    if (g.code === "ACTIVE_LIST" && (g.blocking ?? 0) > 0) return null; // зависи кога ще приключиш
    if (g.code === "PAUSED") return null;
  }
  return null;
}
