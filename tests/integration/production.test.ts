import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { afterEach, describe, expect, it } from "vitest";
import { activeList } from "@/domain/activeList";
import { publishDailyBatch } from "@/domain/batch";
import { ingestCandidate } from "@/domain/ingest";
import { buildArchive, importArchive, readArchive, archiveId, tableDigest, validateArchive, verifyAgainstArchive, writeArchive, type Archive } from "@/domain/migration";
import { processOutbox, recordPushReceipt, type Transports } from "@/domain/notifications";
import { recordOutcome } from "@/domain/outcomes";
import { schedulerTick } from "@/domain/scheduler";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { workerHealth } from "@/domain/workerState";
import { hashPassword } from "@/lib/auth";
import { createDb, tx } from "@/lib/db";
import { deliveriesEnabled, getEnv, resetEnvCache, schedulerEnabled, type Env } from "@/lib/env";
import { clientIpFrom, originAllowed } from "@/lib/requestGuards";
import { schemaStatus } from "@/lib/schemaVersion";
import { zonedToUtc } from "@/lib/time";
import { createSmtpTransport, createWebPushTransport, type EmailTransport, type PushTransport } from "@/providers/delivery";
import { closeDb, isPgTest, testDb, type TestCtx } from "./helpers";
import { adminExec, createPgTestDb, dropPgTestDb } from "./pgTest";

/**
 * Production сценарии: пренос на данни, конкурентно публикуване от отделни процеси, worker (heartbeat, schema,
 * SIGTERM, временна DB грешка), известия (разписки, остарели, cutover, dry-run транспорти), production конфигурация.
 * Работят и върху SQLite, и върху PostgreSQL (npm run test:pg); преносът към PostgreSQL — само с LF_TEST_PG_URL.
 */
let ctx: TestCtx | null = null;
const extra: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of extra.splice(0)) await f().catch(() => {});
  if (ctx) await closeDb(ctx);
  ctx = null;
});

const at = (d: string, t = "08:00") => zonedToUtc(d, t);
const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");
let seq = 0;

async function lead(c: TestCtx, o: Record<string, unknown> = {}) {
  seq++;
  return tx(c.db, (t) =>
    ingestCandidate(
      t,
      {
        name: `ПРОД Тест ${seq}`,
        city: "Варна",
        category: "auto",
        phone: `+35988${String(6_000_000 + seq)}`,
        source: "XLSX",
        sourceUsageConfirmed: true,
        verifiedAt: c.clock.now(),
        contactHistoryState: "NONE_CONFIRMED",
        websiteStatus: "UNCHECKED",
        ...o,
      } as never,
      c.clock.now(),
    ),
  );
}

function runChild(args: string[]) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [TSX, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ------------------------------------------------------------------------------------------------ */

describe("конкурентно публикуване: два worker процеса + web заявка", () => {
  it("един списък, ≤25 уникални допустими реални бизнеса, един логически набор известия; без прозвънени/DNC/издадени/демо/общ телефон", async () => {
    ctx = await testDb({ mode: "real", now: "2026-10-15T05:00:00Z", settings: { leadSource: "REAL" } }); // чт 08:00
    // Вече издаден и обработен списък от сряда — бизнесите в него не са „нови“ повече.
    const old: string[] = [];
    for (let i = 0; i < 5; i++) old.push((await lead(ctx)).businessId);
    ctx.clock.set(at("2026-10-14", "08:05"));
    const prev = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(prev.total).toBe(5);
    for (const [i, id] of old.entries()) await recordOutcome(ctx, { businessId: id, outcome: "SPOKE", callConnected: true, idempotencyKey: `idem-key-prev-${i}-${seq}` } as never);
    ctx.clock.set(at("2026-10-14", "12:00"));
    const good: string[] = [];
    for (let i = 0; i < 30; i++) good.push((await lead(ctx)).businessId);
    const called = (await lead(ctx, { contactHistoryState: "HAS_HISTORY" })).businessId;
    const demo = (await lead(ctx, { isDemo: true, source: "DEMO", phone: `DEMO-${900000 + seq}` })).businessId;
    const dnc = (await lead(ctx, { phone: "+359888100200" })).businessId;
    await recordOutcome(ctx, { businessId: dnc, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: `idem-key-dnc-${seq}` } as never);
    const sameDncPhone = (await lead(ctx, { name: "ПРОД Друго име", phone: "+359 888 100 200" })).businessId;

    const iso = at("2026-10-15", "08:00").toISOString();
    ctx.clock.set(iso);
    const [w1, w2, web] = await Promise.all([
      runChild([path.resolve("tests/integration/fixtures/tick-child.ts"), ctx.url, iso, "real"]),
      runChild([path.resolve("tests/integration/fixtures/tick-child.ts"), ctx.url, iso, "real"]),
      publishDailyBatch(ctx, { trigger: "manual" }),
    ]);
    expect(w1.code, w1.err).toBe(0);
    expect(w2.code, w2.err).toBe(0);
    expect(web.localDate).toBe("2026-10-15");
    expect(await ctx.db.dailyBatch.count({ where: { localDate: "2026-10-15" } })).toBe(1);
    const items = await ctx.db.dailyBatchItem.findMany({ where: { batch: { localDate: "2026-10-15" } } });
    expect(items.length).toBe(25);
    const ids = new Set(items.map((i) => i.businessId));
    expect(ids.size).toBe(25);
    for (const id of ids) expect(good).toContain(id);
    for (const bad of [...old, called, demo, dnc, sameDncPhone]) expect(ids.has(bad)).toBe(false);
    const ob = await ctx.db.notificationOutbox.findMany({ where: { localDate: "2026-10-15" } });
    expect(ob.map((o) => o.kind).sort()).toEqual(["DAILY_READY", "FALLBACK_EMAIL"]);
    expect(await ctx.db.jobRun.count({ where: { key: "publish:2026-10-15", status: "succeeded" } })).toBe(1);
  }, 180_000);

  it("Europe/Sofia: 00:30 местно (21:30 UTC предния ден) е новата дата; 07:59:59 не публикува, 08:00:00 публикува", async () => {
    ctx = await testDb({ mode: "real", now: "2026-10-15T21:30:00Z", settings: { leadSource: "REAL" } }); // пт 16.10 00:30 EEST
    for (let i = 0; i < 26; i++) await lead(ctx);
    let r = await schedulerTick(ctx, { owner: "w", discovery: null });
    expect(r.localDate).toBe("2026-10-16");
    expect(r.published).toBeUndefined();
    ctx.clock.set("2026-10-16T04:59:59Z");
    expect((await schedulerTick(ctx, { owner: "w", discovery: null })).published).toBeUndefined();
    ctx.clock.set("2026-10-16T05:00:00Z");
    r = await schedulerTick(ctx, { owner: "w", discovery: null });
    expect(r.published).toMatchObject({ localDate: "2026-10-16", total: 25 });
    // зимно време: 26.10 (пн) 08:00 = 06:00 UTC; 05:59:59 UTC още не
    for (const [i, it] of (await ctx.db.dailyBatchItem.findMany()).entries()) await recordOutcome(ctx, { businessId: it.businessId, outcome: "SPOKE", callConnected: true, idempotencyKey: `idem-key-w-${i}-${seq}` } as never);
    for (let i = 0; i < 3; i++) await lead(ctx);
    ctx.clock.set("2026-10-26T05:59:59Z");
    expect((await schedulerTick(ctx, { owner: "w", discovery: null })).published).toBeUndefined();
    ctx.clock.set("2026-10-26T06:00:00Z");
    expect((await schedulerTick(ctx, { owner: "w", discovery: null })).published).toMatchObject({ localDate: "2026-10-26" });
  }, 120_000);
});

/* ------------------------------------------------------------------------------------------------ */

describe("worker процес (production команда)", () => {
  function startWorker(url: string, extraEnv: Record<string, string> = {}): ChildProcess {
    const p = spawn(process.execPath, [TSX, path.resolve("src/worker/index.ts")], {
      env: { ...process.env, APP_ENV: "local", APP_MODE: "demo", DATABASE_URL: url, WORKER_TICK_SECONDS: "5", LEADFLOW_ENV_FILE: ".env.does-not-exist", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let log = "";
    p.stdout!.on("data", (d) => (log += d));
    p.stderr!.on("data", (d) => (log += d));
    (p as ChildProcess & { log: () => string }).log = () => log;
    extra.push(async () => {
      if (p.exitCode === null) p.kill();
    });
    return p;
  }
  const stop = (p: ChildProcess) =>
    new Promise<number>((resolve) => {
      p.on("exit", (code) => resolve(code ?? -1));
      // Linux/CI: истински SIGTERM. Windows няма POSIX сигнали за дъщерни процеси → IPC към същия handler.
      if (process.platform === "win32") p.send("shutdown");
      else p.kill("SIGTERM");
    });

  it("heartbeat → ready; SIGTERM: спира, освобождава lease-овете, записва stopped и затваря връзките; после health = спрян", async () => {
    ctx = await testDb({ now: new Date().toISOString(), settings: { paused: true } }); // без демо генериране — тества се самият процес
    const p = startWorker(ctx.url);
    const hb = await until(async () => {
      const h = await workerHealth(ctx!.db, 180);
      return h.status === "ok" ? h : null;
    });
    expect(hb.state).toBe("ready");
    expect(hb.lastSuccessAt).not.toBeNull();
    expect(hb.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
    // lease, който „държи“ този worker (симулира прекъсната задача) → трябва да се освободи при спиране
    const row = await ctx.db.workerHeartbeat.findFirstOrThrow();
    await ctx.db.jobRun.create({ data: { key: "publish:2099-01-01", type: "publish", status: "running", leaseOwner: row.id, leaseUntil: new Date(Date.now() + 3_600_000), attempts: 1 } });
    const code = await stop(p);
    expect(code).toBe(0);
    const after = await ctx.db.workerHeartbeat.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("stopped");
    expect(after.stoppedAt).not.toBeNull();
    expect((await ctx.db.jobRun.findUniqueOrThrow({ where: { key: "publish:2099-01-01" } })).leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await workerHealth(ctx.db, 180)).status).toBe("stale");
  }, 120_000);

  // Render пуска startCommand (`npm run worker:start`) и праща SIGTERM на този процес. Сигналът трябва да мине
  // npm → sh → tsx → worker; иначе worker-ът би бил убит без освобождаване на lease-овете. Само POSIX (CI на Linux).
  it.skipIf(process.platform === "win32")("Linux: SIGTERM само към `npm run worker:start` достига worker-а → чисто спиране, изход 0", async () => {
    ctx = await testDb({ now: new Date().toISOString(), settings: { paused: true } });
    const p = spawn("npm", ["run", "--silent", "worker:start"], {
      env: { ...process.env, APP_ENV: "local", APP_MODE: "demo", DATABASE_URL: ctx.url, WORKER_TICK_SECONDS: "5", LEADFLOW_ENV_FILE: ".env.does-not-exist" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    p.stdout!.on("data", (d) => (log += d));
    p.stderr!.on("data", (d) => (log += d));
    extra.push(async () => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    });
    const row = await until(async () => (await ctx!.db.workerHeartbeat.findFirst({ where: { state: "ready" } })) ?? null);
    await ctx.db.jobRun.create({ data: { key: "publish:2099-01-02", type: "publish", status: "running", leaseOwner: row.id, leaseUntil: new Date(Date.now() + 3_600_000), attempts: 1 } });
    const t0 = Date.now();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      p.on("exit", (code, signal) => resolve({ code, signal }));
      p.kill("SIGTERM"); // само горният процес, не process group
    });
    expect(exit, log).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(30_000); // под graceful периода на Render (60 s)
    expect(log).toMatch(/SIGTERM: спира приемането на нова работа/);
    const after = await ctx.db.workerHeartbeat.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("stopped");
    expect((await ctx.db.jobRun.findUniqueOrThrow({ where: { key: "publish:2099-01-02" } })).leaseUntil!.getTime()).toBeLessThanOrEqual(Date.now());
  }, 120_000);

  it("несъвместима schema (непозната миграция) → worker не обработва нищо и показва проблема", async () => {
    ctx = await testDb({ now: new Date().toISOString(), settings: { activeWeekdays: [1, 2, 3, 4, 5, 6, 7], publishTime: "00:01", prepareTime: "00:00" } });
    for (let i = 0; i < 30; i++) await lead(ctx, { isDemo: true, source: "DEMO", phone: `DEMO-${700000 + seq}` });
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count") VALUES ('future-test', 'x', '29990101000000_future', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
    );
    const s = await schemaStatus(ctx.db);
    expect(s.ok).toBe(false);
    expect(s.unknown).toEqual(["29990101000000_future"]);
    const p = startWorker(ctx.url);
    const h = await until(async () => {
      const x = await workerHealth(ctx!.db, 180);
      return x.state === "waiting_schema" ? x : null;
    });
    expect(h.status).toBe("problem");
    expect(h.text).toMatch(/schema/);
    expect(await ctx.db.dailyBatch.count()).toBe(0);
    expect(await ctx.db.jobRun.count()).toBe(0);
    await stop(p);
  }, 120_000);

  it.skipIf(!isPgTest)("PostgreSQL: прекъснати DB връзки (временна грешка) → bounded retry и възстановяване без рестарт", async () => {
    ctx = await testDb({ now: new Date().toISOString(), settings: { paused: true } });
    const p = startWorker(ctx.url);
    const first = await until(async () => (await ctx!.db.workerHeartbeat.findFirst({ where: { state: "ready" } })) ?? null);
    await adminExec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${ctx.pgName}' AND application_name <> 'lf-test-admin' AND pid <> pg_backend_pid()`);
    // тестовият клиент също е прекъснат — Prisma се свързва наново при следващата заявка
    const later = await until(async () => {
      const r = await ctx!.db.workerHeartbeat.findUnique({ where: { id: first.id } }).catch(() => null);
      return r && r.state === "ready" && r.lastSuccessAt && r.lastSuccessAt > first.lastSuccessAt! ? r : null;
    }, 90_000);
    expect(later.state).toBe("ready");
    expect(p.exitCode).toBeNull();
    await stop(p);
  }, 150_000);

  it("остарял heartbeat → owner вижда „не работи“; без heartbeat → няма данни", async () => {
    ctx = await testDb();
    expect((await workerHealth(ctx.db, 180)).status).toBe("none");
    const old = new Date(Date.now() - 10 * 60_000);
    await ctx.db.workerHeartbeat.create({ data: { id: "worker-old", startedAt: old, beatAt: old, state: "ready", schemaOk: true, schedulerEnabled: true, deliveriesEnabled: true, lastSuccessAt: old } });
    const h = await workerHealth(ctx.db, 180);
    expect(h.status).toBe("stale");
    expect(h.text).toMatch(/Няма heartbeat/);
    await ctx.db.workerHeartbeat.update({ where: { id: "worker-old" }, data: { beatAt: new Date(), state: "scheduler_disabled" } });
    expect((await workerHealth(ctx.db, 180)).status).toBe("problem");
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("известия: разписки, остарели, cutover, dry-run", () => {
  const tr = (push: PushTransport | null, email: EmailTransport | null): Transports => ({ push, email, baseUrl: "https://leadflow.example.test" });
  const okPush = (sent: string[]): PushTransport => ({ send: async (t) => (sent.push(t.endpoint), { ok: true, statusCode: 201 }) });
  const okEmail = (sent: string[]): EmailTransport => ({ send: async (m) => (sent.push(m.idempotencyKey), { ok: true, messageId: "m" }) });

  async function realWithList() {
    const c = await testDb({ mode: "real", now: "2026-10-15T05:00:30Z", settings: { leadSource: "REAL" } });
    for (let i = 0; i < 25; i++) await lead(c);
    await publishDailyBatch(c, { trigger: "scheduler" });
    await c.db.pushSubscription.create({ data: { endpoint: "https://push.example.invalid/s/1", p256dh: "p".repeat(20), auth: "a".repeat(12) } });
    return c;
  }

  it("payload без контакти, с еднократен token; „показано“ от service worker → резервният имейл не се изпраща; provider_accepted сам не спира имейла", async () => {
    ctx = await realWithList();
    const push = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { kind: "DAILY_READY" } });
    const payload = JSON.parse(push.payload) as { title: string; body: string; url: string; rt: string };
    expect(payload.url).toBe("/today");
    expect(payload.rt.length).toBeGreaterThan(16);
    expect(push.receiptTokenHash).not.toContain(payload.rt);
    const names = (await ctx.db.business.findMany({ select: { name: true, phoneNormalized: true } })).flatMap((b) => [b.name, b.phoneNormalized ?? "-"]);
    for (const n of names) expect(push.payload).not.toContain(n);
    const pushSent: string[] = [];
    const mailSent: string[] = [];
    await processOutbox(ctx, tr(okPush(pushSent), okEmail(mailSent)));
    expect(pushSent).toHaveLength(1);
    // provider_accepted, но няма разписка → в часа на резервния имейл той се изпраща
    const email = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { kind: "FALLBACK_EMAIL" } });
    expect(email.notBefore.toISOString()).toBe(new Date(at("2026-10-15", "08:00").getTime() + 30 * 60_000 + 30_000).toISOString()); // от действителното публикуване
    // втори сценарий: разписка „shown“ преди часа → имейлът се пропуска
    expect(await recordPushReceipt(ctx.db, "грешен-token-xxxxxxxx", "shown", new Date())).toBe(false);
    expect(await recordPushReceipt(ctx.db, payload.rt, "shown", new Date())).toBe(true);
    ctx.clock.set(email.notBefore);
    await processOutbox(ctx, tr(okPush(pushSent), okEmail(mailSent)));
    expect(mailSent).toHaveLength(0);
    const e2 = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { id: email.id } });
    expect(e2.status).toBe("skipped");
    expect(e2.lastError).toMatch(/service worker/);
    await recordPushReceipt(ctx.db, payload.rt, "clicked", new Date());
    const p2 = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { id: push.id } });
    expect(p2.swReceivedAt).not.toBeNull();
    expect(p2.openedAt).not.toBeNull();
    expect(p2.status).toBe("provider_accepted"); // ≠ доставено/прочетено
  });

  it("без разписка → един резервен имейл в часа; известие за минала дата не се изпраща (skipped); cutover_hold не се обработва", async () => {
    ctx = await realWithList();
    const sent: string[] = [];
    const mail: string[] = [];
    await processOutbox(ctx, tr(okPush(sent), okEmail(mail)));
    const email = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { kind: "FALLBACK_EMAIL" } });
    ctx.clock.set(new Date(email.notBefore.getTime() - 1000));
    await processOutbox(ctx, tr(okPush(sent), okEmail(mail)));
    expect(mail).toHaveLength(0);
    ctx.clock.set(email.notBefore);
    await processOutbox(ctx, tr(okPush(sent), okEmail(mail)));
    await processOutbox(ctx, tr(okPush(sent), okEmail(mail)));
    expect(mail).toEqual(["email:fallback:2026-10-15"]);
    // вчерашно и задържано
    const y = await ctx.db.notificationOutbox.create({ data: { dedupeKey: "push:daily:2026-10-14", channel: "PUSH", kind: "DAILY_READY", localDate: "2026-10-14", payload: "{}", notBefore: at("2026-10-14") } });
    const h = await ctx.db.notificationOutbox.create({ data: { dedupeKey: "held", channel: "PUSH", kind: "DAILY_READY", localDate: "2026-10-15", payload: "{}", notBefore: at("2026-10-15"), status: "cutover_hold" } });
    const before = sent.length;
    await processOutbox(ctx, tr(okPush(sent), okEmail(mail)));
    expect(sent.length).toBe(before);
    expect((await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { id: y.id } })).status).toBe("skipped");
    expect((await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { id: h.id } })).status).toBe("cutover_hold");
  });

  it("NOTIFY_DRY_RUN: истинският web-push адаптер криптира/подписва, а SMTP адаптерът изгражда съобщението — без мрежа; статус simulated", async () => {
    ctx = await realWithList();
    const sub = await ctx.db.pushSubscription.findFirstOrThrow();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    await ctx.db.pushSubscription.update({ where: { id: sub.id }, data: { endpoint: "https://fcm.googleapis.com/fcm/send/dry-run-test", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } });
    const vapid = webpush.generateVAPIDKeys();
    const env = {
      APP_ENV: "local",
      APP_MODE: "real",
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:owner@example.test",
      SMTP_HOST: "smtp.example.invalid",
      SMTP_PORT: 587,
      SMTP_FROM: "leadflow@example.test",
      OWNER_NOTIFY_EMAIL: "owner@example.test",
      NOTIFY_DRY_RUN: true,
    } as unknown as Env;
    const t: Transports = { push: await createWebPushTransport(env), email: await createSmtpTransport(env), baseUrl: "https://leadflow.example.test" };
    await processOutbox(ctx, t);
    const push = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { kind: "DAILY_READY" }, include: { deliveries: true } });
    expect(push.status).toBe("simulated");
    expect(push.deliveries.map((d) => d.result)).toEqual(["simulated"]);
    const email = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { kind: "FALLBACK_EMAIL" } });
    ctx.clock.set(email.notBefore);
    await processOutbox(ctx, t);
    expect((await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { id: email.id } })).status).toBe("simulated");
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("production конфигурация и достъп", () => {
  const base = { APP_MODE: "real", DATABASE_URL: "postgresql://u:p@dpg-abc-a/leadflow", APP_BASE_URL: "https://leadflow.example.com", APP_ENV: "production" };
  function envWith(v: Record<string, string | undefined>) {
    const old = { ...process.env };
    try {
      for (const k of ["APP_ENV", "APP_MODE", "DATABASE_URL", "APP_BASE_URL", "SCHEDULER_ENABLED", "DELIVERIES_ENABLED", "RENDER", "ALLOWED_ORIGINS", "TRUSTED_PROXY_HOPS"]) delete process.env[k];
      Object.assign(process.env, v);
      resetEnvCache();
      return getEnv();
    } finally {
      process.env = old;
      resetEnvCache();
    }
  }

  it("production изисква PostgreSQL, real, https canonical; без празна SQLite, без изключена проверка на сертификата", () => {
    const ok = envWith(base);
    expect(schedulerEnabled(ok)).toBe(false); // gates са изключени по подразбиране в production
    expect(deliveriesEnabled(ok)).toBe(false);
    expect(schedulerEnabled(envWith({ ...base, SCHEDULER_ENABLED: "true" }))).toBe(true);
    expect(() => envWith({ ...base, DATABASE_URL: "file:../data/real.db" })).toThrow(/PostgreSQL/);
    expect(() => envWith({ ...base, APP_MODE: "demo", DATABASE_URL: "postgresql://u:p@h/leadflow_demo" })).toThrow(/APP_MODE=real/);
    expect(() => envWith({ ...base, APP_BASE_URL: "http://leadflow.example.com" })).toThrow(/https/);
    expect(() => envWith({ ...base, APP_BASE_URL: "https://localhost:3015" })).toThrow(/https/);
    expect(() => envWith({ ...base, DATABASE_URL: "postgresql://u:p@dpg-abc-a.frankfurt-postgres.render.com/leadflow" })).toThrow(/sslmode=require/);
    expect(envWith({ ...base, DATABASE_URL: "postgresql://u:p@dpg-abc-a.frankfurt-postgres.render.com/leadflow?sslmode=require" }).APP_ENV).toBe("production");
    expect(() => envWith({ ...base, DATABASE_URL: "postgresql://u:p@dpg-abc-a/leadflow?sslaccept=accept_invalid_certs" })).toThrow(/accept_invalid_certs/);
    expect(() => envWith({ APP_MODE: "real", DATABASE_URL: "postgresql://u:p@h/leadflow", RENDER: "true" })).toThrow(/APP_ENV=production/);
    // паролата не участва в проверката за demo/test име на базата
    expect(envWith({ ...base, DATABASE_URL: "postgresql://u:mytestdemo@dpg-abc-a/leadflow" }).APP_MODE).toBe("real");
    // локално gates остават включени (поведението на локалната система не се променя)
    const local = envWith({ APP_MODE: "demo", DATABASE_URL: "file:../data/demo.db" });
    expect(schedulerEnabled(local) && deliveriesEnabled(local)).toBe(true);
  });

  it("Origin: в production само canonical/ALLOWED_ORIGINS (Host header не дава доверие); IP само от доверения proxy", () => {
    const env = envWith({ ...base, ALLOWED_ORIGINS: "https://www.leadflow.example.com" });
    // Обикновен Headers обект: Request би изхвърлил забранените заглавки host/sec-fetch-*, а тук те са входът.
    const req = (origin: string | null, host = "evil.example.net", site = "same-origin") =>
      ({ headers: new Headers({ ...(origin ? { origin } : {}), host, "sec-fetch-site": site }) }) as unknown as Request;
    expect(originAllowed(req("https://leadflow.example.com"), env)).toBe(true);
    expect(originAllowed(req("https://www.leadflow.example.com"), env)).toBe(true);
    expect(originAllowed(req("https://evil.example.net"), env)).toBe(false); // съвпада с Host, но не е разрешен
    expect(originAllowed(req(null), env)).toBe(false);
    expect(originAllowed(req("https://leadflow.example.com", "leadflow.example.com", "cross-site"), env)).toBe(false);
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.9, 203.0.113.7" });
    expect(clientIpFrom(h, env)).toBe("203.0.113.7"); // добавеното от Render, не подаденото от клиента
    expect(clientIpFrom(h, envWith({ APP_MODE: "demo", DATABASE_URL: "file:../data/demo.db" }))).toBe("local");
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe.skipIf(!isPgTest)("пренос SQLite → PostgreSQL (синтетични данни)", () => {
  /** Синтетична SQLite база като локалната: реални записи (вкл. 3 „прозвънени преди импорта“), демо история, активен списък. */
  async function sqliteSource() {
    const file = path.resolve(`tests/.tmp/mig-src-${randomBytes(4).toString("hex")}-test.db`);
    const url = `file:${file.split(path.sep).join("/")}`;
    execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    const db = await createDb(url, "test");
    const c = { db, mode: "demo" as const, clock: { now: () => new Date("2026-10-15T09:00:00Z") }, actor: "test", file, url } as unknown as TestCtx;
    await db.systemMeta.create({ data: { id: 1, mode: "demo" } });
    await db.appSettings.create({ data: { id: 1, data: JSON.stringify({ ...DEFAULT_SETTINGS, leadSource: "REAL" }) } });
    await db.user.create({ data: { username: "owner", passwordHash: await hashPassword(`Synthetic-${randomBytes(6).toString("hex")}`) } });
    await db.session.create({ data: { id: "s".repeat(64), userId: (await db.user.findFirstOrThrow()).id, expiresAt: new Date("2030-01-01") } });
    for (let i = 0; i < 5; i++) await lead(c, { isDemo: true, source: "DEMO", phone: `DEMO-${800000 + seq}` });
    for (let i = 0; i < 30; i++) await lead(c);
    for (let i = 0; i < 3; i++) await lead(c, { contactHistoryState: "HAS_HISTORY" });
    await db.business.updateMany({ where: { contactHistoryState: "HAS_HISTORY" }, data: { priorContact: "CALLED_BEFORE_IMPORT", priorContactSource: "OWNER_CONFIRMATION" } });
    await db.business.updateMany({ where: { isDemo: false, contactHistoryState: "NONE_CONFIRMED" }, data: { priorContact: "NOT_CALLED", priorContactSource: "OWNER_CONFIRMATION", sourceCheckedOn: "2026-09-15" } });
    (c.clock as { now: () => Date }).now = () => at("2026-10-15", "08:01");
    const pub = await publishDailyBatch(c, { trigger: "scheduler" });
    const its = await db.dailyBatchItem.findMany({ where: { batchId: pub.batchId }, orderBy: { position: "asc" } });
    for (const [i, it] of its.slice(0, 22).entries()) await recordOutcome(c, { businessId: it.businessId, outcome: i % 2 ? "SPOKE" : "NO_ANSWER", callConnected: i % 2 === 1, idempotencyKey: `idem-key-mig-${i}-${seq}` } as never);
    await recordOutcome(c, { businessId: its[23]!.businessId, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: `idem-key-mig-dnc-${seq}` } as never);
    await db.pushSubscription.create({ data: { endpoint: "https://push.example.invalid/local", p256dh: "p".repeat(20), auth: "a".repeat(12) } });
    await db.offer.create({ data: { businessId: its[1]!.businessId, service: "Сайт", oneTimeCents: 45000, monthlyCents: 2500, offerDate: "2026-10-15" } });
    return { db, file, c };
  }

  async function emptyPg() {
    const pg = await createPgTestDb();
    const db = await createDb(pg.url, "test");
    extra.push(async () => {
      await db.$disconnect();
      await dropPgTestDb(pg.name);
    });
    return db;
  }

  const counts = async (db: Awaited<ReturnType<typeof createDb>>) => ({ b: await db.business.count(), i: await db.dailyBatchItem.count(), a: await db.auditLog.count(), m: await db.systemMeta.count() });

  it("пълен пренос: ID/връзки/моменти/статуси, owner hash, без сесии, cutover_hold, активният списък; повторен импорт = 0 промени; друг архив → отказ", async () => {
    const src = await sqliteSource();
    extra.push(() => src.db.$disconnect());
    const dir = path.dirname(src.file);
    const a = await buildArchive(src.db, new Date(), "test");
    const file = path.join(dir, `mig-${randomBytes(4).toString("hex")}-archive.json.gz`);
    const id = writeArchive(file, a);
    expect(id).toBe(archiveId(file));
    const v = validateArchive(readArchive(file), { targetMode: "real" });
    expect(v.errors).toEqual([]);
    expect(v.transformations.join(" ")).toMatch(/demo" → "real/);

    const db = await emptyPg();
    const r = await importArchive(db, readArchive(file), id, { targetMode: "real" });
    expect(r.status).toBe("imported");
    const ver = await verifyAgainstArchive(db, readArchive(file), id);
    expect(ver.tables.filter((t) => !t.valuesMatch)).toEqual([]);
    expect(ver.orphanChecks.filter((o) => o.orphans)).toEqual([]);

    // конкретни стойности: същите ID и моменти, статус на обработване, произход
    const sItems = await src.db.dailyBatchItem.findMany({ orderBy: { id: "asc" } });
    const tItems = await db.dailyBatchItem.findMany({ orderBy: { id: "asc" } });
    expect(tItems.map((i) => [i.id, i.businessId, i.processedAt?.toISOString() ?? null, i.processedOutcome, i.issuedAt.toISOString()])).toEqual(
      sItems.map((i) => [i.id, i.businessId, i.processedAt?.toISOString() ?? null, i.processedOutcome, i.issuedAt.toISOString()]),
    );
    expect((await db.dailyBatch.findFirstOrThrow()).localDate).toBe("2026-10-15");
    expect((await db.user.findFirstOrThrow()).passwordHash).toBe((await src.db.user.findFirstOrThrow()).passwordHash);
    expect(await db.session.count()).toBe(0);
    expect((await db.systemMeta.findUniqueOrThrow({ where: { id: 1 } })).mode).toBe("real");
    expect((await db.pushSubscription.findFirstOrThrow()).revokedAt).not.toBeNull();
    expect(await db.business.count({ where: { priorContact: "CALLED_BEFORE_IMPORT" } })).toBe(3);
    expect(await db.business.count({ where: { sourceCheckedOn: "2026-09-15" } })).toBe(await src.db.business.count({ where: { sourceCheckedOn: "2026-09-15" } }));
    expect((await db.offer.findFirstOrThrow()).oneTimeCents).toBe(45000);
    const [sal, tal] = [await activeList(src.db, { realOnly: true }), await activeList(db, { realOnly: true })];
    expect(tal).toEqual(sal);
    expect(tal.remaining).toBe(2); // 25 − 22 записани − 1 DNC
    expect(await db.notificationOutbox.count({ where: { status: { in: ["queued", "retry_scheduled", "processing"] } } })).toBe(0);
    expect(await db.notificationOutbox.count({ where: { status: "cutover_hold" } })).toBe(await src.db.notificationOutbox.count({ where: { status: { in: ["queued", "retry_scheduled", "processing"] } } }));

    // повторен импорт със същия архив → 0 промени
    const before = await counts(db);
    expect((await importArchive(db, readArchive(file), id, { targetMode: "real" })).status).toBe("already-imported");
    expect(await counts(db)).toEqual(before);
    // друг архив върху вече пренесена база → отказ преди промяна
    const file2 = file.replace("-archive", "-archive2");
    const id2 = writeArchive(file2, { ...a, createdBy: "другият" });
    await expect(importArchive(db, readArchive(file2), id2, { targetMode: "real" })).rejects.toThrow(/ДРУГ пренесен архив/);
    expect(await counts(db)).toEqual(before);
    for (const f of [file, file2]) fs.rmSync(f, { force: true });
  }, 240_000);

  it("повреден архив, осиротяла връзка и грешка на DB ограничение по средата → нищо не е записано", async () => {
    const src = await sqliteSource();
    extra.push(() => src.db.$disconnect());
    const a = await buildArchive(src.db, new Date(), "test");
    const dir = path.dirname(src.file);
    const tmp = (name: string) => path.join(dir, `mig-${randomBytes(4).toString("hex")}-${name}.json.gz`);

    // 1) счупен gzip
    const f1 = tmp("broken");
    writeArchive(f1, a);
    const buf = fs.readFileSync(f1);
    { const mid = Math.floor(buf.length / 2); buf[mid] = (buf[mid] ?? 0) ^ 0xff; }
    fs.writeFileSync(f1, buf);
    expect(() => readArchive(f1)).toThrow(/повреден/);

    // 2) променена стойност без нова контролна сума
    const clone = () => JSON.parse(JSON.stringify(a)) as Archive;
    const b2 = clone();
    b2.tables.Business!.rows[0]![1] = "L-999999";
    const v2 = validateArchive(b2, { targetMode: "real" });
    expect(v2.ok).toBe(false);
    expect(v2.errors.join(" ")).toMatch(/контролната сума/);

    // 3) осиротяла връзка с „поправена“ контролна сума → отказ преди запис
    const b3 = clone();
    const t3 = b3.tables.DailyBatchItem!;
    const bi = t3.fields.findIndex((f) => f.name === "businessId");
    t3.rows[0]![bi] = "несъществуващ-id";
    t3.sha256 = tableDigest(t3.rows);
    const db = await emptyPg();
    const f3 = tmp("orphan");
    const id3 = writeArchive(f3, b3);
    await expect(importArchive(db, readArchive(f3), id3, { targetMode: "real" })).rejects.toThrow(/осиротели/);
    expect(await counts(db)).toEqual({ b: 0, i: 0, a: 0, m: 0 });

    // 4) стойност, която минава архивната проверка, но нарушава PostgreSQL CHECK по средата на импорта → rollback на всичко
    const b4 = clone();
    const t4 = b4.tables.DailyBatchItem!;
    const pi = t4.fields.findIndex((f) => f.name === "position");
    t4.rows[t4.rows.length - 1]![pi] = 0;
    t4.sha256 = tableDigest(t4.rows);
    const f4 = tmp("check");
    const id4 = writeArchive(f4, b4);
    await expect(importArchive(db, readArchive(f4), id4, { targetMode: "real" })).rejects.toThrow();
    expect(await counts(db)).toEqual({ b: 0, i: 0, a: 0, m: 0 });
    for (const f of [f1, f3, f4]) fs.rmSync(f, { force: true });
  }, 240_000);
});
