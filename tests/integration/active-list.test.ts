import { afterEach, describe, expect, it } from "vitest";
import { activeList, addWorkdays, noAnswerRetryAt } from "@/domain/activeList";
import { publishDailyBatch } from "@/domain/batch";
import { buildCallQueues } from "@/domain/callQueue";
import { ingestCandidate } from "@/domain/ingest";
import { recordDialIntent, recordOutcome } from "@/domain/outcomes";
import { schedulerTick } from "@/domain/scheduler";
import { DEFAULT_SETTINGS, getSettings, saveSettings } from "@/domain/settings";
import { createDb, tx } from "@/lib/db";
import { zonedToUtc } from "@/lib/time";
import { addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

// Календар: пн 12.10.2026 … пт 16.10, сб 17.10, нд 18.10, пн 19.10, вт 20.10.
const at = (d: string, t = "08:00") => zonedToUtc(d, t);
let n = 0;
/** Реални (не-демо) допустими кандидати с валиден формат на номера — никога не се набират. */
async function realLeads(c: TestCtx, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    n++;
    const r = await tx(c.db, (t) =>
      ingestCandidate(
        t,
        { name: `РЕАЛЕН Тест ${n}`, city: "Варна", category: "auto", phone: `+35988${String(5_000_000 + n)}`, source: "XLSX", sourceUsageConfirmed: true, verifiedAt: c.clock.now(), contactHistoryState: "NONE_CONFIRMED", websiteStatus: "UNCHECKED" },
        c.clock.now(),
      ),
    );
    ids.push(r.businessId);
  }
  return ids;
}
const items = async (c: TestCtx, localDate: string) => (await c.db.dailyBatch.findUnique({ where: { localDate }, include: { items: { orderBy: { position: "asc" } } } }))?.items ?? [];
const outcome = (c: TestCtx, businessId: string, o: string, key: string, extra: Record<string, unknown> = {}) => recordOutcome(c, { businessId, outcome: o, idempotencyKey: key, ...extra } as never);
const tick = (c: TestCtx, owner = "w1") => schedulerTick(c, { owner, discovery: null });

async function realCtx(now: string) {
  const c = await testDb({ mode: "real", now });
  await realLeads(c, 80);
  return c;
}

describe("работни дни и повторно обаждане", () => {
  it("след 2 работни дни: пн→ср, чт→пн, пт→вт; 3 дни: пт→ср; начало на работния ден 08:00", () => {
    expect(addWorkdays("2026-10-12", 2)).toBe("2026-10-14");
    expect(addWorkdays("2026-10-15", 2)).toBe("2026-10-19");
    expect(addWorkdays("2026-10-16", 2)).toBe("2026-10-20");
    expect(addWorkdays("2026-10-16", 3)).toBe("2026-10-21");
    expect(noAnswerRetryAt(at("2026-10-16", "15:40"), DEFAULT_SETTINGS)).toEqual(at("2026-10-20", "08:00"));
    expect(DEFAULT_SETTINGS.activeWeekdays).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("активен списък до приключване (реален режим)", () => {
  it("22 от 25 обработени → на следващия работен ден същите 3, без нови 25; „Позвъни“ не приключва; рестарт пази правилата", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z"); // пн 08:00
    const r1 = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(r1).toMatchObject({ created: true, total: 25 });
    const list = await items(ctx, "2026-10-12");
    for (const [i, it] of list.slice(0, 22).entries()) await outcome(ctx, it.businessId, "SPOKE", `spoke-key-${i}`);
    // „Позвъни“ (dial intent) и отваряне не са обработване
    await recordDialIntent(ctx, list[22]!.businessId, "dial-intent-22");
    // вторник 08:00
    ctx.clock.set(at("2026-10-13"));
    const t = await tick(ctx);
    expect(t.skipped).toMatch(/Активният списък не е приключен: остават 3/);
    const manual = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(manual.created).toBe(false);
    expect(manual.blocked?.code).toBe("ACTIVE_LIST");
    expect(await ctx.db.dailyBatch.findUnique({ where: { localDate: "2026-10-13" } })).toBeNull();
    const a = await activeList(ctx.db, { realOnly: true });
    expect(a).toMatchObject({ total: 25, handled: 22, remaining: 3 });
    const q = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(q.queues.new.map((e) => e.businessId)).toEqual(list.slice(22).map((x) => x.businessId));
    expect(q.queues.new[0]!.note).toMatch(/Активен списък от 12\.10\.2026/);
    // рестарт: нов DB клиент — същото състояние
    await ctx.db.$disconnect();
    ctx = { ...ctx, db: await createDb(ctx.url) };
    expect((await activeList(ctx.db, { realOnly: true })).remaining).toBe(3);
    expect(await ctx.db.notificationOutbox.count({ where: { kind: "DAILY_READY" } })).toBe(1); // без известие за несъществуващ нов списък
  });

  it("приключване след 08:00 → нов списък чак в следващия работен ден 08:00; без автоматичен веднага", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z");
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    const list = await items(ctx, "2026-10-12");
    ctx.clock.set(at("2026-10-13", "07:30"));
    for (const [i, it] of list.slice(0, 24).entries()) await outcome(ctx, it.businessId, "SPOKE", `after-key-${i}`);
    ctx.clock.set(at("2026-10-13", "08:00"));
    expect((await tick(ctx)).skipped).toMatch(/остават 1/);
    ctx.clock.set(at("2026-10-13", "10:00"));
    await outcome(ctx, list[24]!.businessId, "SPOKE", "a-key-last");
    ctx.clock.set(at("2026-10-13", "10:05"));
    expect((await tick(ctx)).skipped).toMatch(/приключен след 08:00/);
    const m = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(m.blocked?.code).toBe("ACTIVE_LIST");
    expect(await ctx.db.dailyBatch.count()).toBe(1);
    ctx.clock.set(at("2026-10-14", "08:00"));
    const t = await tick(ctx);
    expect(t.published).toMatchObject({ localDate: "2026-10-14", created: true, total: 25 });
  });

  it("приключен преди 08:00, приложението стартирано след 08:00 → закъсняло публикуване само за днес; без наваксване", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z");
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    for (const [i, it] of (await items(ctx, "2026-10-12")).entries()) await outcome(ctx, it.businessId, "SPOKE", `before-key-${i}`);
    ctx.clock.set(at("2026-10-15", "11:00")); // компютърът е бил изключен вт–чт сутрин
    const t = await tick(ctx);
    expect(t.published).toMatchObject({ localDate: "2026-10-15", created: true });
    expect((await ctx.db.dailyBatch.findUniqueOrThrow({ where: { localDate: "2026-10-15" } })).late).toBe(true);
    expect(await ctx.db.dailyBatch.count()).toBe(2); // 13.10 и 14.10 не са наваксани
  });

  it("петък с останали контакти → събота и неделя без нов списък/подготовка/известие; в понеделник контактите са налични", async () => {
    ctx = await realCtx("2026-10-16T05:00:00Z"); // пт 08:00
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    const list = await items(ctx, "2026-10-16");
    for (const [i, it] of list.slice(0, 20).entries()) await outcome(ctx, it.businessId, "SPOKE", `friday-key-${i}`);
    for (const d of ["2026-10-17", "2026-10-18"]) {
      ctx.clock.set(at(d, "09:00"));
      expect((await tick(ctx)).skipped).toMatch(/не е активен/);
      const m = await publishDailyBatch(ctx, { trigger: "manual" });
      expect(m.blocked?.code).toBe("NOT_WORKDAY");
      expect(m.blocked?.reason).toMatch(/понеделник–петък/);
    }
    expect(await ctx.db.jobRun.count({ where: { key: { in: ["prepare:2026-10-17", "publish:2026-10-17", "prepare:2026-10-18", "publish:2026-10-18"] } } })).toBe(0);
    expect(await ctx.db.notificationOutbox.count({ where: { kind: "DAILY_READY" } })).toBe(1);
    ctx.clock.set(at("2026-10-19", "08:00"));
    expect((await tick(ctx)).skipped).toMatch(/остават 5/);
    const q = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(q.queues.new).toHaveLength(5);
    // ръчното записване на резултат работи и през уикенда
    ctx.clock.set(at("2026-10-17", "12:00"));
    await outcome(ctx, list[20]!.businessId, "SPOKE", "weekend-key-1");
    expect((await activeList(ctx.db, { realOnly: true })).remaining).toBe(4);
  });

  it("едновременни worker процеси и ръчно публикуване → един списък за деня", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z");
    const [a, b, c] = await Promise.all([tick(ctx, "wA"), tick(ctx, "wB"), publishDailyBatch(ctx, { trigger: "manual" })]);
    expect(await ctx.db.dailyBatch.count()).toBe(1);
    expect((await items(ctx, "2026-10-12")).length).toBe(25);
    expect([a.published, b.published, c].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  it("вече издаден контакт остава видим след срока за свежест; свежестта важи само за нови кандидати", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z");
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    const list = await items(ctx, "2026-10-12");
    await ctx.db.business.updateMany({ where: {}, data: { verifiedAt: new Date("2026-08-01T00:00:00Z") } }); // всички остарели
    ctx.clock.set(at("2026-10-13"));
    const q = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(q.queues.new).toHaveLength(25);
    for (const [i, it] of list.entries()) await outcome(ctx, it.businessId, "SPOKE", `fresh-key-${i}`);
    ctx.clock.set(at("2026-10-14"));
    const r = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(r.blocked?.code).toBe("NO_CANDIDATES"); // остарелите неиздадени не влизат
    expect((await ctx.db.business.findFirstOrThrow({ where: { id: list[0]!.businessId } })).verifiedAt).toEqual(new Date("2026-08-01T00:00:00Z"));
  });

  it("демо историята не блокира реалните списъци", async () => {
    ctx = await testDb({ now: "2026-10-12T05:00:00Z" }); // demo база
    await addLeads(ctx, 30); // демо
    await publishDailyBatch(ctx, { trigger: "demo" }); // демо списък, необработен
    await realLeads(ctx, 30);
    const s = await getSettings(ctx.db);
    await saveSettings(ctx.db, { ...s, leadSource: "REAL" });
    ctx.clock.set(at("2026-10-13"));
    const r = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(r).toMatchObject({ created: true, total: 25 });
    const its = await ctx.db.dailyBatchItem.findMany({ where: { batch: { localDate: "2026-10-13" } }, include: { business: true } });
    expect(its.every((i) => !i.business.isDemo)).toBe(true);
  });
});

describe("„Не отговори“ → автоматично повторно обаждане", () => {
  it("петък → вторник 08:00; повторна заявка/запис не дублира; повторен „не отговори“ планира нов; ръчна дата и 3 дни; DNC отменя", async () => {
    ctx = await realCtx("2026-10-16T05:00:00Z");
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    const [b1, b2, b3] = (await items(ctx, "2026-10-16")).map((i) => i.businessId);
    ctx.clock.set(at("2026-10-16", "10:00"));
    const r = await outcome(ctx, b1!, "NO_ANSWER", "na-key-1");
    expect(r.retryAt).toBe(at("2026-10-20").toISOString());
    // двойно натискане / повторна заявка със същия ключ → същата задача
    const dup = await outcome(ctx, b1!, "NO_ANSWER", "na-key-1");
    expect(dup).toMatchObject({ duplicate: true, retryAt: r.retryAt, followUpId: r.followUpId });
    expect(await ctx.db.followUp.count({ where: { businessId: b1, kind: "RETRY" } })).toBe(1);
    // участието е обработено с „Не отговори“ (първи опит), не се връща назад от по-късни промени
    const item = await ctx.db.dailyBatchItem.findUniqueOrThrow({ where: { businessId: b1 } });
    expect(item.processedOutcome).toBe("NO_ANSWER");
    // повторното обаждане е в отделната опашка във вторник; не е в активния списък
    ctx.clock.set(at("2026-10-20", "09:00"));
    let q = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(q.queues.followups.map((e) => e.businessId)).toContain(b1);
    expect(q.queues.new.map((e) => e.businessId)).not.toContain(b1);
    // пак не отговори → старата задача е изпълнена, нова по същото правило (вт → чт); една активна
    const r2 = await outcome(ctx, b1!, "NO_ANSWER", "na-key-2");
    expect(r2.retryAt).toBe(at("2026-10-22").toISOString());
    expect(await ctx.db.followUp.count({ where: { businessId: b1, kind: "RETRY", status: "OPEN" } })).toBe(1);
    expect(await ctx.db.followUp.count({ where: { businessId: b1, kind: "RETRY", status: "DONE" } })).toBe(1);
    expect(await ctx.db.activity.count({ where: { businessId: b1, outcome: "NO_ANSWER" } })).toBe(2); // историята на опитите
    // изрично избрана дата има предимство
    ctx.clock.set(at("2026-10-16", "11:00"));
    const manualDate = at("2026-10-27", "14:30");
    const r3 = await outcome(ctx, b2!, "NO_ANSWER", "na-key-3", { retryAt: manualDate });
    expect(r3.retryAt).toBe(manualDate.toISOString());
    // настройка 3 работни дни: пт → ср
    const s = await getSettings(ctx.db);
    await saveSettings(ctx.db, { ...s, noAnswerRetryWorkdays: 3 });
    const r4 = await outcome(ctx, b3!, "NO_ANSWER", "na-key-4");
    expect(r4.retryAt).toBe(at("2026-10-21").toISOString());
    // DNC отменя повторното обаждане
    await outcome(ctx, b3!, "DO_NOT_CONTACT", "na-key-5", { callConnected: false });
    expect(await ctx.db.followUp.count({ where: { businessId: b3, status: "OPEN" } })).toBe(0);
    q = await buildCallQueues(ctx.db, at("2026-10-21", "09:00"));
    expect(q.queues.followups.map((e) => e.businessId)).not.toContain(b3);
  });

  it("бизнес с повторно обаждане не влиза отново в нови списъци и не се брои към следващите 25", async () => {
    ctx = await realCtx("2026-10-12T05:00:00Z");
    await publishDailyBatch(ctx, { trigger: "scheduler" });
    const list = await items(ctx, "2026-10-12");
    for (const [i, it] of list.entries()) await outcome(ctx, it.businessId, "NO_ANSWER", `nr-key-${i}`);
    ctx.clock.set(at("2026-10-13"));
    const r = await publishDailyBatch(ctx, { trigger: "scheduler" });
    expect(r).toMatchObject({ created: true, total: 25 });
    const next = await items(ctx, "2026-10-13");
    const prev = new Set(list.map((x) => x.businessId));
    expect(next.some((x) => prev.has(x.businessId))).toBe(false);
    // неприключени повторни обаждания сами по себе си не блокират следващия списък
    expect(await ctx.db.followUp.count({ where: { status: "OPEN", kind: "RETRY" } })).toBe(25);
  });
});
