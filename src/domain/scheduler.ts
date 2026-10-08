import type { JobRun } from "@prisma/client";
import { audit, isUniqueViolation, type Ctx } from "@/lib/db";
import { localDateOf, weekdayOf, zonedToUtc } from "@/lib/time";
import { publishDailyBatch, reserveStatus } from "./batch";
import { rescore } from "./rescore";
import { getSettings } from "./settings";
import { newListGate, realOnlyFor } from "./activeList";
import type { DemoDiscovery } from "@/providers/candidates";

/**
 * Дневен scheduler (server-side, в отделния worker процес). Идемпотентен "tick":
 *  1. prepare:<date> след prepareTime — подготовка на резерв от разрешен активен provider;
 *  2. publish:<date> след publishTime — публикуване в транзакция + outbox;
 *  catch-up: САМО за текущата локална дата (закъснял), никога за пропуснати минали дни.
 * Jobs: уникален key, lease, attempts, ограничени retries с backoff.
 */

export const JOB_MAX_ATTEMPTS = 4;
const LEASE_MS = 5 * 60_000;
const LATE_AFTER_MS = 15 * 60_000;

export async function claimJob(ctx: Pick<Ctx, "db" | "clock">, key: string, type: string, owner: string): Promise<JobRun | null> {
  const now = ctx.clock.now();
  const existing = await ctx.db.jobRun.findUnique({ where: { key } });
  if (!existing) try {
    return await ctx.db.jobRun.create({ data: { key, type, status: "running", leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: 1, startedAt: now } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const j = await ctx.db.jobRun.findUnique({ where: { key } });
  if (!j) return null;
  const retryable = j.status === "failed" && j.attempts < JOB_MAX_ATTEMPTS && (!j.nextRetryAt || j.nextRetryAt <= now);
  const staleLease = j.status === "running" && j.leaseUntil !== null && j.leaseUntil < now;
  if (!retryable && !staleLease) return null;
  const c = await ctx.db.jobRun.updateMany({
    where: { id: j.id, status: j.status, attempts: j.attempts },
    data: { status: "running", leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 }, startedAt: now },
  });
  return c.count === 1 ? ctx.db.jobRun.findUnique({ where: { id: j.id } }) : null;
}

export async function finishJob(ctx: Pick<Ctx, "db" | "clock">, job: JobRun, ok: boolean, result: unknown, error?: string, late = false) {
  const now = ctx.clock.now();
  await ctx.db.jobRun.update({
    where: { id: job.id },
    data: {
      status: ok ? "succeeded" : "failed",
      finishedAt: now,
      leaseUntil: null,
      late,
      result: JSON.stringify(result ?? null),
      lastError: error ?? null,
      nextRetryAt: ok ? null : new Date(now.getTime() + 60_000 * 2 ** job.attempts),
    },
  });
}

export interface TickResult {
  localDate: string;
  skipped?: string;
  prepared?: unknown;
  published?: unknown;
}

export async function schedulerTick(ctx: Ctx, opts: { owner: string; discovery?: DemoDiscovery | null }): Promise<TickResult> {
  const now = ctx.clock.now();
  const localDate = localDateOf(now);
  const s = await getSettings(ctx.db);
  if (s.paused) return { localDate, skipped: "Системата е на пауза." };
  if (!s.activeWeekdays.includes(weekdayOf(localDate))) return { localDate, skipped: "Денят не е активен в настройките." };
  if (s.pauseNewLists) return { localDate, skipped: "Новите списъци са на пауза." };
  // Реален режим: докато активният списък не е приключен, не се подготвя и не се публикува (не се блокира запас).
  if (realOnlyFor(ctx.mode, s)) {
    const existing = !!(await ctx.db.dailyBatch.findUnique({ where: { localDate }, select: { id: true } }));
    const g = await newListGate(ctx.db, s, localDate, now, { existing, realOnly: true });
    if (!g.ok && g.code !== "BEFORE_TIME") return { localDate, skipped: g.reason };
  }

  const out: TickResult = { localDate };
  const prepareAt = zonedToUtc(localDate, s.prepareTime);
  const publishAt = zonedToUtc(localDate, s.publishTime);

  if (now >= prepareAt) {
    const job = await claimJob(ctx, `prepare:${localDate}`, "prepare", opts.owner);
    if (job) {
      try {
        const r = await prepareCandidates(ctx, opts.discovery ?? null);
        await finishJob(ctx, job, true, r);
        out.prepared = r;
      } catch (e) {
        await finishJob(ctx, job, false, null, e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (now >= publishAt) {
    const job = await claimJob(ctx, `publish:${localDate}`, "publish", opts.owner);
    if (job) {
      const late = now.getTime() - publishAt.getTime() > LATE_AFTER_MS;
      try {
        const r = await publishDailyBatch(ctx, { localDate, trigger: "scheduler", late });
        await finishJob(ctx, job, true, r, undefined, late);
        out.published = r;
      } catch (e) {
        await finishJob(ctx, job, false, null, e instanceof Error ? e.message : String(e), late);
      }
    }
  }
  return out;
}

/** Подготовка: ако резервът е под целта и има разрешен активен provider, откриване на нови кандидати. */
export async function prepareCandidates(ctx: Ctx, discovery: DemoDiscovery | null) {
  const s = await getSettings(ctx.db);
  const before = await reserveStatus(ctx.db, ctx.mode, ctx.clock.now());
  let discovered = { created: 0, existing: 0, review: 0 };
  let providerNote = "Няма активен разрешен provider — използва се наличният резерв.";
  if (discovery && s.leadSource === "REAL") {
    providerNote = "Реален източник: демо генераторът е изключен — използва се импортираният запас.";
  } else if (discovery && before.reserve < s.reserveTarget) {
    discovered = await discovery.discover(ctx, s.reserveTarget - before.reserve);
    providerNote = `${discovery.label}: ${discovered.created} нови, ${discovered.existing} вече познати, ${discovered.review} за проверка.`;
  } else if (discovery) {
    providerNote = `Резервът (${before.reserve}) е достатъчен — без ново откриване.`;
  }
  await rescore(ctx.db, ctx.clock.now());
  const after = await reserveStatus(ctx.db, ctx.mode, ctx.clock.now());
  await audit(ctx.db, ctx.actor, "candidates.prepare", undefined, undefined, { before: before.reserve, after: after.reserve, discovered });
  return { reserveBefore: before.reserve, reserveAfter: after.reserve, reserveTarget: s.reserveTarget, discovered, note: providerNote };
}
