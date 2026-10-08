import type { PrismaClient } from "@prisma/client";
import type { Mode } from "@/lib/db";
import { emailConfigured, pushConfigured } from "@/providers/delivery";
import type { Env } from "@/lib/env";
import { addDays, localDateOf, weekdayOf, zonedToUtc } from "@/lib/time";
import { reserveStatus } from "./batch";
import { getSettings } from "./settings";
import { workerHealth } from "./workerState";

export async function nextScheduledRun(db: PrismaClient, now: Date) {
  const s = await getSettings(db);
  if (s.paused) return null;
  const today = localDateOf(now);
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    if (!s.activeWeekdays.includes(weekdayOf(d))) continue;
    const at = zonedToUtc(d, s.publishTime);
    const published = await db.dailyBatch.findUnique({ where: { localDate: d } });
    if (at > now || (i === 0 && !published)) return { localDate: d, at };
  }
  return null;
}

/** Health за UI (само за влязъл owner). Публичният /api/health връща само ok/version. */
export async function healthSummary(db: PrismaClient, env: Env, mode: Mode, now: Date) {
  const s = await getSettings(db);
  const today = localDateOf(now);
  const [hb, jobs, batch, pendingN, failedN, subs, reserve, next] = await Promise.all([
    workerHealth(db, env.WORKER_STALE_SECONDS),
    db.jobRun.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    db.dailyBatch.findUnique({ where: { localDate: today }, include: { _count: { select: { items: true } } } }),
    db.notificationOutbox.count({ where: { status: { in: ["queued", "retry_scheduled", "processing"] } } }),
    db.notificationOutbox.count({ where: { status: "failed" } }),
    db.pushSubscription.count({ where: { revokedAt: null, expiredAt: null } }),
    reserveStatus(db, mode, now),
    nextScheduledRun(db, now),
  ]);
  // Heartbeat е в реално (системно) време, независимо от demo offset. „Работи“ само при пресен пулс в състояние ready.
  const heartbeatAt = hb.beatAt;
  const workerAlive = hb.status === "ok";
  const pushReady = mode === "real" && pushConfigured(env) && subs > 0 && s.notifications.pushEnabled;
  const emailReady = mode === "real" && emailConfigured(env) && s.notifications.emailFallbackEnabled;
  const notifications =
    mode === "demo"
      ? { state: "DEMO_SIMULATED" as const, text: "DEMO: известията са само локални previews." }
      : pushReady || emailReady
        ? { state: "PARTIAL" as const, text: `${pushReady ? "Push: конфигуриран" : "Push: неактивен"} · ${emailReady ? "Имейл: конфигуриран" : "Имейл: неактивен"} (не е доказана доставка)` }
        : { state: "INACTIVE" as const, text: "Няма активен канал за известия — нито push, нито имейл." };
  return {
    today,
    workerAlive,
    heartbeatAt,
    worker: hb,
    jobs,
    batch: batch ? { total: batch._count.items, target: batch.target, publishedAt: batch.publishedAt, late: batch.late, shortfall: batch.shortfallReason } : null,
    pendingN,
    failedN,
    subs,
    reserve,
    next,
    notifications,
    paused: s.paused || s.pauseNewLists,
  };
}
