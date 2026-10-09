import os from "node:os";
import { randomBytes } from "node:crypto";
import { loadDotEnv } from "../../scripts/_env";
import { assertDbMode, createDb } from "@/lib/db";
import { deliveriesEnabled, getEnv, schedulerEnabled } from "@/lib/env";
import { processOutbox } from "@/domain/notifications";
import { schedulerTick } from "@/domain/scheduler";
import { schemaStatus } from "@/lib/schemaVersion";
import { beat, pruneHeartbeats, releaseLeases, type WorkerState } from "@/domain/workerState";
import { buildTransports, discoveryFor, workerCtx } from "./runtime";

/**
 * Отделен scheduler/outbox worker (локално: npm run worker:dev; Render Background Worker: node --import tsx src/worker/index.ts — без npm, за да стига SIGTERM).
 * Един постоянно работещ процес; при рестарт всичко се възстановява от базата (JobRun, outbox, списъци).
 *  - Не обработва нищо, докато приложените миграции не съвпадат с кода (schema readiness) и базата не е инициализирана.
 *  - SCHEDULER_ENABLED / DELIVERIES_ENABLED (production gates) — изключени по подразбиране в production.
 *  - Heartbeat в таблица WorkerHeartbeat → owner вижда последно успешно изпълнение, следваща проверка и грешка.
 *  - SIGTERM: спира приемането на нова работа, изчаква текущия tick, освобождава lease-овете, затваря DB.
 * Логовете съдържат job ID, време и причина — без имена/телефони на контакти.
 */
const VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? process.env.npm_package_version ?? null;
const MAX_BACKOFF_MS = 5 * 60_000;
const SHUTDOWN_WAIT_MS = 25_000;

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(`[worker] ${new Date().toISOString()} ${msg}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`);

async function main() {
  loadDotEnv();
  const env = getEnv(); // невалидна конфигурация → изход 1 (production: само PostgreSQL, real, https)
  const db = await createDb(env.DATABASE_URL, "worker");
  const id = `worker-${process.pid}-${randomBytes(3).toString("hex")}`;
  const sched = schedulerEnabled(env);
  const deliv = deliveriesEnabled(env);
  const transports = await buildTransports(env);
  const startedAt = new Date();
  log("старт", { id, env: env.APP_ENV, mode: env.APP_MODE, tickSeconds: env.WORKER_TICK_SECONDS, scheduler: sched, deliveries: deliv });

  let stopping = false;
  let running: Promise<void> | null = null;
  let failures = 0;
  let lastSuccessAt: Date | null = null;

  const record = (state: WorkerState, extra: { schemaOk: boolean; error?: string | null; nextCheckAt?: Date }) =>
    beat(db, { id, host: os.hostname().slice(0, 60), version: VERSION, startedAt, state, schedulerEnabled: sched, deliveriesEnabled: deliv, lastSuccessAt, ...extra }).catch((e) =>
      log("heartbeat не е записан", { reason: e instanceof Error ? e.message.slice(0, 200) : "грешка" }),
    );

  await pruneHeartbeats(db).catch(() => {});

  const tick = async (): Promise<number> => {
    const next = () => new Date(Date.now() + env.WORKER_TICK_SECONDS * 1000);
    try {
      const schema = await schemaStatus(db);
      if (!schema.ok) {
        log("schema не е съвместима — без обработка", { missing: schema.missing, unknown: schema.unknown, failed: schema.failed });
        await record("waiting_schema", { schemaOk: false, error: "Миграциите не съвпадат с кода (изчаква db:deploy или замяна на стария процес).", nextCheckAt: next() });
        return env.WORKER_TICK_SECONDS * 1000;
      }
      try {
        await assertDbMode(db, env.APP_MODE);
      } catch (e) {
        await record("waiting_data", { schemaOk: true, error: e instanceof Error ? e.message.slice(0, 300) : "База без данни", nextCheckAt: next() });
        return env.WORKER_TICK_SECONDS * 1000;
      }
      const ctx = await workerCtx(db, env); // demo clock може да е преместен ("следващ ден")
      if (sched) {
        const r = await schedulerTick(ctx, { owner: id, discovery: discoveryFor(env) });
        if (r.published || r.prepared) log("scheduler", { localDate: r.localDate, prepared: !!r.prepared, published: r.published ?? null });
      }
      if (deliv) {
        const o = await processOutbox(ctx, transports);
        if (o.length) log("outbox", { results: o });
      }
      failures = 0;
      lastSuccessAt = new Date();
      await record(sched ? "ready" : "scheduler_disabled", { schemaOk: true, error: null, nextCheckAt: next() });
      return env.WORKER_TICK_SECONDS * 1000;
    } catch (e) {
      // Временни DB/мрежови грешки: ограничен експоненциален backoff; worker-ът не спира.
      failures++;
      const wait = Math.min(MAX_BACKOFF_MS, env.WORKER_TICK_SECONDS * 1000 * 2 ** Math.min(failures - 1, 6));
      const reason = e instanceof Error ? e.message.split("\n").slice(-3).join(" ").slice(0, 300) : "грешка";
      log("грешка в tick", { failures, retryInSeconds: Math.round(wait / 1000), reason });
      await record("error", { schemaOk: true, error: reason, nextCheckAt: new Date(Date.now() + wait) });
      return wait;
    }
  };

  const loop = async () => {
    while (!stopping) {
      let wait = env.WORKER_TICK_SECONDS * 1000;
      running = tick().then((w) => {
        wait = w;
      });
      await running;
      running = null;
      for (let waited = 0; waited < wait && !stopping; waited += 100) await new Promise((r) => setTimeout(r, 100));
    }
  };

  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: спира приемането на нова работа`, { id });
    const timeout = new Promise((r) => setTimeout(r, SHUTDOWN_WAIT_MS));
    if (running) await Promise.race([running, timeout]);
    try {
      const n = await releaseLeases(db, id);
      await beat(db, { id, host: os.hostname().slice(0, 60), version: VERSION, startedAt, state: "stopped", schemaOk: true, schedulerEnabled: sched, deliveriesEnabled: deliv, lastSuccessAt, stopped: true });
      log("спрян", { releasedLeases: n });
    } catch (e) {
      log("спиране: базата не е достъпна", { reason: e instanceof Error ? e.message.slice(0, 200) : "грешка" });
    }
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows няма POSIX сигнали за дъщерни процеси: тестовете изпращат IPC "shutdown" към същия път на спиране.
  process.on("message", (m) => m === "shutdown" && void shutdown("IPC shutdown"));
  await record("starting", { schemaOk: false });
  await loop();
}

main().catch((e) => {
  console.error(`[worker] ${new Date().toISOString()} фатална грешка: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
