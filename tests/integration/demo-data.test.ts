import { afterEach, describe, expect, it, vi } from "vitest";
import { backupDb, dbTotals, verifyBackup } from "@/domain/backup";
import { previewSelection, publishDailyBatch } from "@/domain/batch";
import { exportLeadsCsv } from "@/domain/csv";
import { simulateNextDay } from "@/domain/demo";
import { ingestCandidate } from "@/domain/ingest";
import { recordOutcome } from "@/domain/outcomes";
import { seedDemo } from "@/domain/seed";
import { assertDbMode, tx } from "@/lib/db";
import { getEnv, resetEnvCache } from "@/lib/env";
import { localDateOf } from "@/lib/time";
import { fetchPlaceDisplay, googlePlacesGate } from "@/providers/candidates";
import { addLeads, closeDb, testDb, type TestCtx, isPgTest } from "./helpers";

let ctx: TestCtx;
afterEach(async () => {
  vi.restoreAllMocks();
  if (ctx) await closeDb(ctx);
});

describe("demo, seed и dry-run", () => {
  it("T42 seed отказва real DB; повторен seed запазва ръчните промени; ~400 записа и ≥200 допустими", async () => {
    const real = await testDb({ mode: "real" });
    await expect(seedDemo(real)).rejects.toThrow(/само за demo/);
    expect(await real.db.business.count()).toBe(0);
    await closeDb(real);

    ctx = await testDb({ now: "2026-10-07T05:30:00Z" });
    const r1 = await seedDemo(ctx);
    expect(r1.skipped).toBe(false);
    expect(await ctx.db.business.count()).toBeGreaterThanOrEqual(400);
    expect(await ctx.db.business.count({ where: { name: { startsWith: "ДЕМО" } } })).toBe(await ctx.db.business.count());
    const outcomes = await ctx.db.activity.findMany({ where: { type: "CALL" }, distinct: ["outcome"], select: { outcome: true } });
    expect(outcomes).toHaveLength(9); // всички девет резултата в историята
    const preview = await previewSelection(ctx.db, "demo", ctx.clock.now(), localDateOf(ctx.clock.now()));
    expect(preview.poolSize).toBeGreaterThanOrEqual(200 - 75); // ≥200 преди първото разпределение; 3 минали дни по 25 вече издадени
    const someone = await ctx.db.business.findFirstOrThrow({ where: { firstIssuedAt: null } });
    await ctx.db.business.update({ where: { id: someone.id }, data: { notes: "моя ръчна бележка" } });
    const r2 = await seedDemo(ctx);
    expect(r2.skipped).toBe(true);
    expect((await ctx.db.business.findUniqueOrThrow({ where: { id: someone.id } })).notes).toBe("моя ръчна бележка");
  });

  it("T35 dry-run е без writes; next-day е demo-only и не пипа real", async () => {
    ctx = await testDb();
    await addLeads(ctx, 80);
    const before = await dbTotals(ctx.db);
    const audits = await ctx.db.auditLog.count();
    const p = await previewSelection(ctx.db, "demo", ctx.clock.now(), localDateOf(ctx.clock.now()));
    expect(p.items).toHaveLength(25);
    expect(await dbTotals(ctx.db)).toEqual(before);
    expect(await ctx.db.auditLog.count()).toBe(audits);
    expect(await ctx.db.dailyBatch.count()).toBe(0);

    await publishDailyBatch(ctx, { trigger: "demo" });
    const nd = await simulateNextDay(ctx);
    expect(nd.offset).toBe(1);
    expect(nd.publish.localDate).not.toBe(localDateOf(ctx.clock.now()));
    const rows = await ctx.db.notificationOutbox.findMany({ where: { localDate: nd.localDate } });
    expect(rows.find((o) => o.channel === "PUSH")?.status).toBe("simulated"); // in-app preview, не реална доставка
    expect(["queued", "simulated"]).toContain(rows.find((o) => o.channel === "EMAIL")?.status); // fallback чака +30 мин.

    const real = await testDb({ mode: "real" });
    await expect(simulateNextDay(real)).rejects.toThrow(/забранени в real/);
    expect((await real.db.systemMeta.findUniqueOrThrow({ where: { id: 1 } })).demoDayOffset).toBe(0);
    await closeDb(real);
  });

  it("fail-closed: базата е от друг режим; env отказва demo с real файл", async () => {
    ctx = await testDb({ mode: "demo" });
    await expect(assertDbMode(ctx.db, "real")).rejects.toThrow(/fail-closed/);
    const old = { ...process.env };
    try {
      process.env.APP_MODE = "real";
      process.env.DATABASE_URL = "file:../data/demo.db";
      resetEnvCache();
      expect(() => getEnv()).toThrow(/real не може/);
      process.env.APP_MODE = "demo";
      process.env.DATABASE_URL = "file:../data/real.db";
      resetEnvCache();
      expect(() => getEnv()).toThrow(/demo изисква/);
    } finally {
      process.env = old;
      resetEnvCache();
    }
  });
});

describe("T43 backup и възстановяване", () => {
  // SQLite VACUUM INTO. PostgreSQL backup/restore: npm run pg:backup / pg:restore-check (отделна проверка).
  it.skipIf(isPgTest)("restore в отделна DB съвпада по totals/history/DNC", async () => {
    ctx = await testDb();
    const ids = await addLeads(ctx, 30);
    await publishDailyBatch(ctx, { trigger: "manual" });
    await recordOutcome(ctx, { businessId: ids[0]!, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "bk-dnc-0001" });
    await recordOutcome(ctx, { businessId: ids[1]!, outcome: "WON", deal: { service: "Сайт", oneTimeCents: 1000, startDate: "2026-10-07" }, idempotencyKey: "bk-won-0001" });
    const dir = ctx.file.replace(/[^\\/]+$/, "");
    const file = await backupDb(ctx.db, "demo", dir);
    const v = await verifyBackup(ctx.db, file);
    expect(v.ok).toBe(true);
    expect(v.restored.activeDnc).toBe(1);
    expect(v.restored.batchItems).toBe(25);
    expect(v.restoredFile).not.toBe(ctx.file);
  });
});

describe("T41 ограничено съдържание от доставчик", () => {
  it("DISPLAY_ONLY стойности не стигат до DB, export или audit", async () => {
    ctx = await testDb({ mode: "real" });
    const secretPhone = "0886123456";
    await tx(ctx.db, (t) =>
      ingestCandidate(
        t,
        {
          name: "ОГРАНИЧЕН Fixture",
          city: "Варна",
          category: "auto",
          phone: secretPhone,
          rating: 4.9,
          reviewCount: 321,
          ratingSource: "Google",
          placeId: "ChIJ_restricted_fixture_1",
          source: "GOOGLE_PLACES",
          sourceUsageConfirmed: false,
          contactHistoryState: "UNKNOWN",
          fieldPolicy: { phone: "DISPLAY_ONLY", rating: "DISPLAY_ONLY", reviewCount: "DISPLAY_ONLY", ratingSource: "DISPLAY_ONLY", placeId: "ID_ONLY" },
        },
        ctx.clock.now(),
      ),
    );
    const b = await ctx.db.business.findFirstOrThrow({ include: { identifiers: true } });
    expect(b.phoneRaw).toBeNull();
    expect(b.rating).toBeNull();
    expect(b.identifiers.map((i) => i.type)).toContain("PLACE_ID");
    const all = JSON.stringify(await ctx.db.business.findMany({ include: { identifiers: true, evidence: true } })) + JSON.stringify(await ctx.db.auditLog.findMany());
    expect(all).not.toContain("886123456");
    expect(all).not.toContain("4.9");
    const csv = await exportLeadsCsv(ctx);
    expect(csv).not.toContain("886123456");
  });

  it("Google Places адаптерът е BLOCKED без ключ/условия и не прави заявки", async () => {
    const fetchSpy = vi.fn();
    const env = { APP_MODE: "real", GOOGLE_PLACES_API_KEY: undefined, GOOGLE_PLACES_TERMS_CONFIRMED: false, LIVE_DISCOVERY_ENABLED: false } as unknown as ReturnType<typeof getEnv>;
    expect(googlePlacesGate(env).ok).toBe(false);
    await expect(fetchPlaceDisplay(env, "ChIJ_test_id_123", fetchSpy as never)).rejects.toThrow(/GOOGLE_PLACES_API_KEY/);
    await expect(fetchPlaceDisplay({ ...env, APP_MODE: "demo", GOOGLE_PLACES_API_KEY: "k" } as never, "ChIJ_test_id_123", fetchSpy as never)).rejects.toThrow(/DEMO_MODE/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
