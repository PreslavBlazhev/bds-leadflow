import { afterEach, describe, expect, it, vi } from "vitest";
import { publishDailyBatch } from "@/domain/batch";
import { acknowledgeToday } from "@/domain/crm";
import { processOutbox, type Transports } from "@/domain/notifications";
import { claimJob, schedulerTick } from "@/domain/scheduler";
import { saveSettings, DEFAULT_SETTINGS } from "@/domain/settings";
import { createDb } from "@/lib/db";
import type { EmailTransport, PushTransport } from "@/providers/delivery";
import { addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => {
  vi.restoreAllMocks();
  if (ctx) await closeDb(ctx);
});

function mockPush(behaviour: (endpoint: string) => { ok: true; statusCode: number } | { ok: false; statusCode?: number; expired: boolean; error: string }) {
  const sent: string[] = [];
  const t: PushTransport = { send: async (target) => (sent.push(target.endpoint), behaviour(target.endpoint)) };
  return { t, sent };
}
function mockEmail(ok = true) {
  const sent: { subject: string; text: string; idempotencyKey: string }[] = [];
  const t: EmailTransport = { send: async (m) => (sent.push(m), ok ? { ok: true, messageId: "m1" } : { ok: false, error: "SMTP 451", retryable: true }) };
  return { t, sent };
}
const tr = (push: PushTransport | null, email: EmailTransport | null): Transports => ({ push, email, baseUrl: "http://localhost:3015" });
const addSub = (c: TestCtx, n: number) => c.db.pushSubscription.create({ data: { endpoint: `https://push.example.invalid/sub/${n}`, p256dh: "p".repeat(20), auth: "a".repeat(12) } });

describe("scheduler", () => {
  it("T25 планира 08:00 Europe/Sofia през DST: 25.10.2026 е 06:00 UTC, 24.10 е 05:00 UTC", async () => {
    ctx = await testDb({ now: "2026-10-24T04:59:00Z", settings: { activeWeekdays: [1, 2, 3, 4, 5, 6, 7] } }); // проверява DST, не работните дни
    await addLeads(ctx, 80);
    let r = await schedulerTick(ctx, { owner: "w1" });
    expect(r.published).toBeUndefined(); // 07:59 местно
    ctx.clock.set("2026-10-24T05:00:30Z");
    r = await schedulerTick(ctx, { owner: "w1" });
    expect(r.published).toMatchObject({ localDate: "2026-10-24", total: 25 });
    ctx.clock.set("2026-10-25T05:30:00Z"); // 07:30 зимно време
    r = await schedulerTick(ctx, { owner: "w1" });
    expect(r.published).toBeUndefined();
    ctx.clock.set("2026-10-25T06:00:10Z");
    r = await schedulerTick(ctx, { owner: "w1" });
    expect(r.published).toMatchObject({ localDate: "2026-10-25" });
    expect(await ctx.db.dailyBatch.count()).toBe(2);
  });

  it("T25 пролет: 29.03.2026 08:00 = 05:00 UTC", async () => {
    ctx = await testDb({ now: "2026-03-29T04:59:00Z", settings: { activeWeekdays: [1, 2, 3, 4, 5, 6, 7] } }); // проверява DST, не работните дни
    await addLeads(ctx, 30);
    expect((await schedulerTick(ctx, { owner: "w" })).published).toBeUndefined();
    ctx.clock.set("2026-03-29T05:00:01Z");
    expect((await schedulerTick(ctx, { owner: "w" })).published).toMatchObject({ localDate: "2026-03-29" });
  });

  it("T26 изключен ден или пауза не създават batch/notification jobs", async () => {
    ctx = await testDb({ now: "2026-10-11T07:00:00Z" }); // неделя 10:00
    await addLeads(ctx, 30);
    await saveSettings(ctx.db, { ...DEFAULT_SETTINGS, activeWeekdays: [1, 2, 3, 4, 5] });
    const r = await schedulerTick(ctx, { owner: "w" });
    expect(r.skipped).toMatch(/не е активен/);
    await saveSettings(ctx.db, { ...DEFAULT_SETTINGS, paused: true });
    expect((await schedulerTick(ctx, { owner: "w" })).skipped).toMatch(/пауза/);
    expect(await ctx.db.dailyBatch.count()).toBe(0);
    expect(await ctx.db.notificationOutbox.count()).toBe(0);
    expect(await ctx.db.jobRun.count()).toBe(0);
  });

  it("T27 catch-up след 08:00 генерира само текущия ден, маркиран като закъснял", async () => {
    ctx = await testDb({ now: "2026-10-07T09:00:00Z" }); // 12:00, worker не е работил 3 дни
    await addLeads(ctx, 80);
    const r = await schedulerTick(ctx, { owner: "w" });
    expect(r.published).toMatchObject({ localDate: "2026-10-07" });
    expect((await ctx.db.dailyBatch.findMany()).map((b) => [b.localDate, b.late])).toEqual([["2026-10-07", true]]);
    expect(await ctx.db.notificationOutbox.count()).toBe(2); // само за днес, не десетки стари
    const again = await schedulerTick(ctx, { owner: "w2" });
    expect(again.published).toBeUndefined(); // job key → не се повтаря
  });

  it("lease: втори worker не взема зает job; изтекъл lease се възстановява", async () => {
    ctx = await testDb();
    const a = await claimJob(ctx, "publish:2026-10-07", "publish", "w1");
    expect(a).not.toBeNull();
    expect(await claimJob(ctx, "publish:2026-10-07", "publish", "w2")).toBeNull();
    ctx.clock.advance(6 * 60_000);
    const b = await claimJob(ctx, "publish:2026-10-07", "publish", "w2");
    expect(b?.leaseOwner).toBe("w2");
    expect(b?.attempts).toBe(2);
  });

  it("T28 crash между batch commit и доставка не губи outbox записа", async () => {
    ctx = await testDb({ mode: "real" });
    await addLeads(ctx, 30, { isDemo: false, phone: undefined });
    // real режим изисква E164 телефони — използваме валидни формати само за тест (никога не се набират)
    const biz = await ctx.db.business.findMany();
    for (const [i, b] of biz.entries()) await ctx.db.business.update({ where: { id: b.id }, data: { phoneNormalized: `+3598810${String(i).padStart(5, "0")}`, phoneKind: "E164" } });
    const r = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(r.total).toBe(25);
    // „crash“: worker взема записа и умира по време на изпращане (status=processing, lease остава)
    const row = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `push:daily:${r.localDate}` } });
    await ctx.db.notificationOutbox.update({ where: { id: row.id }, data: { status: "processing", leaseUntil: new Date(ctx.clock.now().getTime() + 120_000), attempts: 1 } });
    await addSub(ctx, 1);
    const p = mockPush(() => ({ ok: true, statusCode: 201 }));
    expect(await processOutbox(ctx, tr(p.t, null))).toHaveLength(0); // lease още важи
    ctx.clock.advance(3 * 60_000);
    // рестарт: нов DB клиент
    await ctx.db.$disconnect();
    ctx = { ...ctx, db: await createDb(ctx.url) };
    const res = await processOutbox(ctx, tr(p.t, null));
    expect(res.find((x) => x.id === row.id)?.status).toBe("provider_accepted");
    expect(p.sent).toHaveLength(1);
  });
});

describe("известия и fallback", () => {
  async function published(mode: "real" | "demo" = "real") {
    ctx = await testDb({ mode });
    await addLeads(ctx, 30);
    if (mode === "real") {
      const biz = await ctx.db.business.findMany();
      for (const [i, b] of biz.entries()) await ctx.db.business.update({ where: { id: b.id }, data: { phoneNormalized: `+3598820${String(i).padStart(5, "0")}`, phoneKind: "E164", isDemo: false } });
    }
    return publishDailyBatch(ctx, { trigger: "scheduler" });
  }

  it("T29 няма push subscription → един fallback email intent веднага", async () => {
    const r = await published();
    const e = mockEmail();
    await processOutbox(ctx, tr(mockPush(() => ({ ok: true, statusCode: 201 })).t, e.t));
    await processOutbox(ctx, tr(null, e.t));
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]!.text).toMatch(/НЕ е доказателство/);
    expect(e.sent[0]!.idempotencyKey).toBe(`email:fallback:${r.localDate}`);
    const push = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `push:daily:${r.localDate}` } });
    expect(push.status).toBe("failed");
    expect(push.lastError).toMatch(/Няма активни push/);
  });

  it("T30 provider accepted не се отчита като доставено/прочетено; T31 отворен списък отменя fallback", async () => {
    const r = await published();
    await addSub(ctx, 1);
    const p = mockPush(() => ({ ok: true, statusCode: 201 }));
    const e = mockEmail();
    await processOutbox(ctx, tr(p.t, e.t));
    const push = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `push:daily:${r.localDate}` } });
    expect(push.status).toBe("provider_accepted");
    expect(await ctx.db.dailyAcknowledgement.count()).toBe(0); // приемане от доставчика ≠ отваряне
    // отваряне на /today преди 30-минутния fallback
    ctx.clock.advance(10 * 60_000);
    await acknowledgeToday(ctx, "open:/today");
    ctx.clock.advance(60 * 60_000);
    await processOutbox(ctx, tr(p.t, e.t));
    expect(e.sent).toHaveLength(0);
    expect((await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `email:fallback:${r.localDate}` } })).status).toBe("acknowledged");
  });

  it("T32 неотворен списък → точно един fallback intent, вкл. при паралелни worker-и", async () => {
    await published();
    await addSub(ctx, 1);
    const p = mockPush(() => ({ ok: true, statusCode: 201 }));
    const e = mockEmail();
    await processOutbox(ctx, tr(p.t, e.t));
    ctx.clock.advance(29 * 60_000);
    await processOutbox(ctx, tr(p.t, e.t));
    expect(e.sent).toHaveLength(0); // още е рано
    ctx.clock.advance(2 * 60_000);
    const other = await createDb(ctx.url);
    await Promise.all([processOutbox(ctx, tr(p.t, e.t)), processOutbox({ ...ctx, db: other }, tr(p.t, e.t)), processOutbox(ctx, tr(p.t, e.t))]);
    await other.$disconnect();
    expect(e.sent).toHaveLength(1);
    ctx.clock.advance(3600_000);
    await processOutbox(ctx, tr(p.t, e.t));
    expect(e.sent).toHaveLength(1);
  });

  it("T33 изтекъл endpoint се маркира; частичен успех не води до множество имейли", async () => {
    const r = await published();
    await addSub(ctx, 1);
    await addSub(ctx, 2);
    await addSub(ctx, 3);
    const p = mockPush((ep) => (ep.endsWith("/1") ? { ok: false, statusCode: 410, expired: true, error: "HTTP 410" } : ep.endsWith("/2") ? { ok: false, statusCode: 500, expired: false, error: "HTTP 500" } : { ok: true, statusCode: 201 }));
    const e = mockEmail();
    await processOutbox(ctx, tr(p.t, e.t));
    const subs = await ctx.db.pushSubscription.findMany({ orderBy: { endpoint: "asc" } });
    expect(subs[0]!.expiredAt).not.toBeNull();
    expect(subs[2]!.lastSuccessAt).not.toBeNull();
    expect((await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `push:daily:${r.localDate}` } })).status).toBe("provider_accepted");
    expect(e.sent).toHaveLength(0); // частичен успех → имейлът остава само като fallback по липса на отваряне
    ctx.clock.advance(40 * 60_000);
    await processOutbox(ctx, tr(p.t, e.t));
    await processOutbox(ctx, tr(p.t, e.t));
    expect(e.sent).toHaveLength(1);
  });

  it("всички endpoints окончателно отказват → един имейл веднага; без SMTP → BLOCKED, не success", async () => {
    const r = await published();
    await addSub(ctx, 1);
    const p = mockPush(() => ({ ok: false, statusCode: 404, expired: true, error: "HTTP 404" }));
    await processOutbox(ctx, tr(p.t, null));
    await processOutbox(ctx, { ...tr(p.t, null), emailBlockedReason: "Липсва SMTP" });
    const email = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `email:fallback:${r.localDate}` } });
    expect(email.status).toBe("failed");
    expect(email.lastError).toMatch(/BLOCKED/);
  });

  it("временна SMTP грешка → retry_scheduled с backoff, ограничени опити", async () => {
    await published();
    const e = mockEmail(false);
    await processOutbox(ctx, tr(null, e.t));
    await processOutbox(ctx, tr(null, e.t));
    const row = await ctx.db.notificationOutbox.findFirstOrThrow({ where: { channel: "EMAIL" } });
    expect(row.status).toBe("retry_scheduled");
    expect(row.notBefore.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
  });

  it("T34 DEMO_MODE не извършва реални доставки или мрежови заявки", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await published("demo");
    await addSub(ctx, 1);
    const p = mockPush(() => ({ ok: true, statusCode: 201 }));
    const e = mockEmail();
    // дори ако по грешка се подадат транспорти, demo режимът не ги вика
    await processOutbox(ctx, tr(p.t, e.t));
    ctx.clock.advance(3600_000);
    await processOutbox(ctx, tr(p.t, e.t));
    expect(p.sent).toHaveLength(0);
    expect(e.sent).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const st = (await ctx.db.notificationOutbox.findMany()).map((o) => o.status);
    expect(st.every((s) => s === "simulated")).toBe(true);
  });
});
