import { afterEach, describe, expect, it } from "vitest";
import { backlogItems, publishDailyBatch } from "@/domain/batch";
import { recordOutcome } from "@/domain/outcomes";
import { createDb } from "@/lib/db";
import { addDays, zonedToUtc } from "@/lib/time";
import { addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const itemsOf = (c: TestCtx, localDate: string) => c.db.dailyBatchItem.findMany({ where: { batch: { localDate } }, orderBy: { position: "asc" } });

describe("дневни списъци", () => {
  it("T01 ден A има точно 25 уникални canonical IDs", async () => {
    ctx = await testDb();
    await addLeads(ctx, 40, { city: "Варна" });
    await addLeads(ctx, 20, { city: "Плевен" });
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(r.total).toBe(25);
    const items = await itemsOf(ctx, r.localDate);
    expect(new Set(items.map((i) => i.businessId)).size).toBe(25);
    const biz = await ctx.db.business.findMany({ where: { id: { in: items.map((i) => i.businessId) } } });
    expect(biz.every((b) => b.mergedIntoId === null && b.firstIssuedAt)).toBe(true);
  });

  it("T02 ден B има други 25 — празно пресичане с всички предишни; T03 непозвънените са backlog", async () => {
    ctx = await testDb();
    await addLeads(ctx, 60, { city: "Варна" });
    await addLeads(ctx, 30, { city: "Плевен" });
    const a = await publishDailyBatch(ctx, { trigger: "manual" });
    const aItems = await itemsOf(ctx, a.localDate);
    // обаждаме се само на 5 от ден A
    for (const it of aItems.slice(0, 5)) await recordOutcome(ctx, { businessId: it.businessId, outcome: "NO_ANSWER", idempotencyKey: `k-${it.id}` });
    ctx.clock.advance(86_400_000);
    const b = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(b.localDate).toBe(addDays(a.localDate, 1));
    expect(b.total).toBe(25);
    const bItems = await itemsOf(ctx, b.localDate);
    const inter = bItems.filter((x) => aItems.some((y) => y.businessId === x.businessId));
    expect(inter).toHaveLength(0);
    const backlog = await backlogItems(ctx.db, b.localDate);
    expect(backlog).toHaveLength(20);
    expect(backlog.every((x) => !bItems.some((y) => y.businessId === x.businessId))).toBe(true);
  });

  it("T04 повторен run/двойно натискане връща същите 25; T13 поредността оцелява след рестарт", async () => {
    ctx = await testDb();
    await addLeads(ctx, 50, { city: "Варна" });
    await addLeads(ctx, 20, { city: "Плевен" });
    const first = await publishDailyBatch(ctx, { trigger: "manual" });
    const before = (await itemsOf(ctx, first.localDate)).map((i) => [i.position, i.businessId]);
    const again = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(again.created).toBe(false);
    expect(again.added).toBe(0);
    expect(again.batchId).toBe(first.batchId);
    // „рестарт“: нов клиент към същия файл
    await ctx.db.$disconnect();
    const db2 = await createDb(ctx.url);
    const after = (await db2.dailyBatchItem.findMany({ where: { batch: { localDate: first.localDate } }, orderBy: { position: "asc" } })).map((i) => [i.position, i.businessId]);
    expect(after).toEqual(before);
    expect(await db2.dailyBatchItem.count()).toBe(25);
    ctx = { ...ctx, db: db2 };
  });

  it("T05 две паралелни заявки (и от два отделни DB клиента) не създават два batch-а или повече от целта", async () => {
    ctx = await testDb();
    await addLeads(ctx, 60, { city: "Варна" });
    await addLeads(ctx, 30, { city: "Плевен" });
    const other = await createDb(ctx.url);
    const octx = { ...ctx, db: other };
    const res = await Promise.all([publishDailyBatch(ctx, { trigger: "manual" }), publishDailyBatch(octx, { trigger: "manual" }), publishDailyBatch(ctx, { trigger: "manual" })]);
    await other.$disconnect();
    expect(new Set(res.map((r) => r.batchId)).size).toBe(1);
    expect(await ctx.db.dailyBatch.count()).toBe(1);
    expect(await ctx.db.dailyBatchItem.count()).toBe(25);
    expect(res.filter((r) => r.created)).toHaveLength(1);
  });

  it("T12 при 17 допустими: 17/25 и предупреждение, без дубликати/фиктивни; допълване по-късно без подмяна", async () => {
    ctx = await testDb();
    await addLeads(ctx, 12, { city: "Варна" });
    await addLeads(ctx, 5, { city: "Плевен" });
    await addLeads(ctx, 10, { city: "Русе" }); // неразрешен град
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(r.total).toBe(17);
    expect(r.shortfallReason).toMatch(/Само 17 от 25/);
    const first = (await itemsOf(ctx, r.localDate)).map((i) => i.businessId);
    await addLeads(ctx, 10, { city: "Варна" });
    const top = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(top.added).toBe(8);
    expect(top.total).toBe(25);
    const now = (await itemsOf(ctx, r.localDate)).map((i) => i.businessId);
    expect(now.slice(0, 17)).toEqual(first);
    const again = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(again.total).toBe(25); // никога 50
  });

  it("0 допустими → честен празен списък", async () => {
    ctx = await testDb();
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(r.total).toBe(0);
    expect(r.shortfallReason).toMatch(/Само 0 от 25/);
  });

  it("T14 само разрешени градове, без скрито разширяване", async () => {
    ctx = await testDb();
    await addLeads(ctx, 30, { city: "Варна" });
    await addLeads(ctx, 2, { city: "Плевен" });
    await addLeads(ctx, 30, { city: "София" });
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    const items = await ctx.db.dailyBatchItem.findMany({ include: { business: true } });
    expect(items.some((i) => i.business.city === "София")).toBe(false);
    expect(r.total).toBe(25);
    expect(r.shortfallReason).toMatch(/Плевен: само 2/);
  });

  it("публикуването и outbox са в една транзакция; scheduledAt е 08:00 Sofia", async () => {
    ctx = await testDb();
    await addLeads(ctx, 30);
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    const b = await ctx.db.dailyBatch.findUniqueOrThrow({ where: { id: r.batchId } });
    expect(b.scheduledAt.toISOString()).toBe(zonedToUtc(r.localDate, "08:00").toISOString());
    const ob = await ctx.db.notificationOutbox.findMany({ where: { localDate: r.localDate } });
    expect(ob.map((o) => o.dedupeKey).sort()).toEqual([`email:fallback:${r.localDate}`, `push:daily:${r.localDate}`]);
    expect(JSON.parse(ob[0]!.payload).body).not.toMatch(/ТЕСТ Бизнес|DEMO-/); // без имена/телефони
  });
});
