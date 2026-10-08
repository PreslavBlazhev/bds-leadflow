import type { PrismaClient } from "@prisma/client";

/** Състояния на worker процеса (WorkerHeartbeat.state). */
export type WorkerState = "starting" | "waiting_schema" | "waiting_data" | "ready" | "scheduler_disabled" | "error" | "stopping" | "stopped";

export interface Beat {
  id: string;
  host?: string | null;
  version?: string | null;
  startedAt: Date;
  state: WorkerState;
  schemaOk: boolean;
  schedulerEnabled: boolean;
  deliveriesEnabled: boolean;
  lastSuccessAt?: Date | null;
  nextCheckAt?: Date;
  error?: string | null;
  stopped?: boolean;
}

/** Heartbeat в реално (системно) време — независимо от demo offset/injected clock на задачите. */
export async function beat(db: PrismaClient, b: Beat, now = new Date()) {
  const data = {
    host: b.host ?? null,
    version: b.version ?? null,
    beatAt: now,
    state: b.state,
    schemaOk: b.schemaOk,
    schedulerEnabled: b.schedulerEnabled,
    deliveriesEnabled: b.deliveriesEnabled,
    lastSuccessAt: b.lastSuccessAt ?? null,
    nextCheckAt: b.nextCheckAt ?? null,
    ...(b.error !== undefined ? { lastError: b.error, lastErrorAt: b.error ? now : undefined } : {}),
    ...(b.stopped ? { stoppedAt: now } : {}),
  };
  await db.workerHeartbeat.upsert({ where: { id: b.id }, create: { id: b.id, startedAt: b.startedAt, ...data }, update: data });
}

/** Спрели процеси по-стари от 7 дни се изтриват (историята на задачите е в JobRun/outbox). */
export async function pruneHeartbeats(db: PrismaClient, now = new Date()) {
  await db.workerHeartbeat.deleteMany({ where: { beatAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } } });
}

/** SIGTERM: незавършените lease-ове на този worker стават свободни веднага (иначе изтичат след LEASE_MS). */
export async function releaseLeases(db: PrismaClient, owner: string, now = new Date()) {
  const r = await db.jobRun.updateMany({ where: { leaseOwner: owner, status: "running" }, data: { leaseUntil: now } });
  return r.count;
}

export interface WorkerHealth {
  /** ok = пресен heartbeat и готов; stale = няма скорошен heartbeat; problem = работи, но не обработва. */
  status: "ok" | "stale" | "problem" | "none";
  text: string;
  beatAt: Date | null;
  lastSuccessAt: Date | null;
  nextCheckAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  state: string | null;
  schedulerEnabled: boolean;
  deliveriesEnabled: boolean;
  staleAfterSeconds: number;
}

/**
 * Състояние за owner екраните. Зелено САМО при пресен heartbeat от worker в състояние ready —
 * работещ сайт не е доказателство, че worker-ът работи.
 */
export async function workerHealth(db: PrismaClient, staleAfterSeconds: number, now = new Date()): Promise<WorkerHealth> {
  const w = await db.workerHeartbeat.findFirst({ orderBy: { beatAt: "desc" } });
  const base = {
    beatAt: w?.beatAt ?? null,
    lastSuccessAt: w?.lastSuccessAt ?? null,
    nextCheckAt: w?.nextCheckAt ?? null,
    lastError: w?.lastError ?? null,
    lastErrorAt: w?.lastErrorAt ?? null,
    state: w?.state ?? null,
    schedulerEnabled: w?.schedulerEnabled ?? false,
    deliveriesEnabled: w?.deliveriesEnabled ?? false,
    staleAfterSeconds,
  };
  if (!w) return { ...base, status: "none", text: "Няма данни от worker — не е стартиран към тази база." };
  if (w.state === "stopped") return { ...base, status: "stale", text: "Worker-ът е спрян." };
  if (now.getTime() - w.beatAt.getTime() > staleAfterSeconds * 1000) {
    return { ...base, status: "stale", text: `Няма heartbeat повече от ${Math.round(staleAfterSeconds / 60)} мин. — worker-ът вероятно не работи.` };
  }
  const problem: Record<string, string> = {
    starting: "Worker-ът стартира.",
    waiting_schema: "Worker-ът чака съвместима schema (миграциите не съвпадат с кода).",
    waiting_data: "Worker-ът чака инициализирана база (пренос на данните).",
    scheduler_disabled: "Worker-ът работи, но графикът е изключен (SCHEDULER_ENABLED).",
    error: "Worker-ът работи, но последната проверка завърши с грешка.",
    stopping: "Worker-ът спира.",
  };
  if (w.state !== "ready") return { ...base, status: "problem", text: problem[w.state] ?? `Състояние: ${w.state}` };
  return { ...base, status: "ok", text: w.deliveriesEnabled ? "Worker-ът работи." : "Worker-ът работи; външните доставки са изключени (DELIVERIES_ENABLED)." };
}
