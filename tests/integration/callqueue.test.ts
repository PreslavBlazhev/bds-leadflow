import { afterEach, describe, expect, it } from "vitest";
import { publishDailyBatch } from "@/domain/batch";
import { buildCallQueues } from "@/domain/callQueue";
import { createFollowUp } from "@/domain/crm";
import { recordOutcome } from "@/domain/outcomes";
import { templatePitch } from "@/domain/pitch";
import { addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const ids = (q: { businessId: string }[]) => q.map((e) => e.businessId);
const unique = (a: string[]) => new Set(a).size === a.length;

describe("опашки за обаждания", () => {
  it("трите опашки са отделни, без повторения; старите контакти никога не са в „Нови днес“", async () => {
    ctx = await testDb({ now: "2026-10-07T06:00:00Z" });
    await addLeads(ctx, 70, { city: "Варна" });
    await addLeads(ctx, 30, { city: "Плевен" });
    const a = await publishDailyBatch(ctx, { trigger: "manual" });
    const dayA = (await ctx.db.dailyBatchItem.findMany({ where: { batchId: a.batchId }, orderBy: { position: "asc" } })).map((i) => i.businessId);
    // ден A: 3 обработени; единият с ДВЕ последващи задачи за днес (трябва да е веднъж в опашката)
    await recordOutcome(ctx, { businessId: dayA[0]!, outcome: "NO_ANSWER", idempotencyKey: "idem-q-1", retryAt: new Date("2026-10-08T07:00:00Z") });
    await createFollowUp(ctx, { businessId: dayA[0]!, dueAt: new Date("2026-10-08T09:00:00Z"), reason: "Втора задача" });
    await recordOutcome(ctx, { businessId: dayA[1]!, outcome: "CALL_BACK", callConnected: true, callbackAt: new Date("2026-10-07T12:00:00Z"), idempotencyKey: "idem-q-2" });
    await recordOutcome(ctx, { businessId: dayA[2]!, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "idem-q-3" });

    ctx.clock.set("2026-10-08T06:30:00Z"); // ден B, 09:30 местно
    const b = await publishDailyBatch(ctx, { trigger: "manual" });
    const dayB = (await ctx.db.dailyBatchItem.findMany({ where: { batchId: b.batchId }, orderBy: { position: "asc" } })).map((i) => i.businessId);

    const q = await buildCallQueues(ctx.db, ctx.clock.now());
    const n = ids(q.queues.new);
    const f = ids(q.queues.followups);
    const old = ids(q.queues.backlog);
    expect(n).toEqual(dayB); // само днешните нови, в поредността на списъка
    expect(n.filter((x) => dayA.includes(x))).toHaveLength(0);
    expect(unique(n) && unique(f) && unique(old)).toBe(true);
    expect(f).toEqual(expect.arrayContaining([dayA[0], dayA[1]])); // просрочено + днешно
    expect(f.filter((x) => x === dayA[0])).toHaveLength(1); // две задачи → един ред
    expect(f).not.toContain(dayA[2]); // DNC
    expect(old).toHaveLength(22); // 25 от ден A − 3 обработени
    expect(old.filter((x) => n.includes(x))).toHaveLength(0);
    expect(q.queues.followups.find((e) => e.businessId === dayA[1])!.note).toMatch(/^Просрочено/);
    expect(q.newProgress).toEqual({ total: 25, done: 0 });

    // запис по нов контакт → излиза от „Нови днес“, прогресът расте
    await recordOutcome(ctx, { businessId: dayB[0]!, outcome: "SPOKE", idempotencyKey: "idem-q-4" });
    const q2 = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(ids(q2.queues.new)).not.toContain(dayB[0]);
    expect(q2.queues.new).toHaveLength(24);
    expect(q2.newProgress).toEqual({ total: 25, done: 1 });
    // необработеният от ден A остава в „Необработени“, никога не става „нов“, независимо от изгледа
    expect(ids(q2.queues.backlog)).toEqual(old);
  });
});

describe("шаблон за начало на разговор", () => {
  const b = { name: "ДЕМО Тест", city: "Варна", category: "auto", openingLine: null, questions: null };
  it("липсващ viewport таг не се представя като факт за лош мобилен вид", () => {
    const p = templatePitch({ ...b, websiteStatus: "FOUND" }, { issues: JSON.stringify(["няма mobile viewport meta"]), https: true, contactVisible: true });
    expect(p.opening).not.toMatch(/viewport|мобил|телефон/i);
    expect(p.opening).toMatch(/Видях, че имате сайт/);
  });
  it("използва само потвърдени факти: http адрес, липсващ контакт, ненамерен сайт", () => {
    expect(templatePitch({ ...b, websiteStatus: "FOUND" }, { issues: JSON.stringify(["няма HTTPS"]), https: false, contactVisible: true }).opening).toMatch(/без защитена връзка/);
    expect(templatePitch({ ...b, websiteStatus: "FOUND" }, { issues: "[]", https: true, contactVisible: false }).opening).toMatch(/не видях телефон или бутон/);
    expect(templatePitch({ ...b, websiteStatus: "NOT_FOUND_AFTER_CHECK" }, null).opening).toMatch(/не открих ваш сайт/);
    const unchecked = templatePitch({ ...b, websiteStatus: "UNCHECKED" }, null).opening;
    expect(unchecked).not.toMatch(/нямате сайт|не открих/i);
  });
});
