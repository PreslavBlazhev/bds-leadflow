import { afterEach, describe, expect, it } from "vitest";
import { createFollowUp, moveStage, setOfferStatus } from "@/domain/crm";
import { DomainError } from "@/domain/errors";
import { recordDialIntent, recordOutcome } from "@/domain/outcomes";
import { computeStats } from "@/domain/stats";
import { localDateOf } from "@/lib/time";
import { addLead, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const biz = (id: string) => ctx.db.business.findUniqueOrThrow({ where: { id }, include: { followUps: true, offers: true, client: true, suppressions: true, activities: true } });

describe("T15 деветте резултата със side effects", () => {
  it("всеки outcome", async () => {
    ctx = await testDb();
    const later = new Date(ctx.clock.now().getTime() + 2 * 86_400_000);
    const ids = await Promise.all(Array.from({ length: 9 }, () => addLead(ctx).then((r) => r.businessId)));
    const [na, spoke, cb, int, offer, won, dec, inv, dnc] = ids as [string, string, string, string, string, string, string, string, string];

    await recordOutcome(ctx, { businessId: na, outcome: "NO_ANSWER", idempotencyKey: "idem-o-na-key", retryAt: later });
    let b = await biz(na);
    expect(b.pipelineStage).toBe("NEW");
    expect(b.activities[0]).toMatchObject({ type: "CALL", callConnected: false });
    expect(b.followUps[0]).toMatchObject({ kind: "RETRY", status: "OPEN" });

    await recordOutcome(ctx, { businessId: spoke, outcome: "SPOKE", idempotencyKey: "idem-o-sp-key", note: "бележка" });
    expect((await biz(spoke)).pipelineStage).toBe("CONTACTED");

    await recordOutcome(ctx, { businessId: cb, outcome: "CALL_BACK", callConnected: false, callbackAt: later, idempotencyKey: "idem-o-cb-key" });
    b = await biz(cb);
    expect(b.followUps[0]).toMatchObject({ kind: "CALL_BACK" });
    expect(b.pipelineStage).toBe("NEW"); // без разговор не става „Контактуван“

    await recordOutcome(ctx, { businessId: int, outcome: "INTERESTED", idempotencyKey: "idem-o-in-key" });
    expect((await biz(int)).pipelineStage).toBe("QUALIFIED");

    const ro = await recordOutcome(ctx, { businessId: offer, outcome: "SEND_OFFER", idempotencyKey: "idem-o-of-key" });
    b = await biz(offer);
    expect(b.pipelineStage).toBe("PROPOSAL");
    expect(b.offers[0]).toMatchObject({ status: "DRAFT", sentAt: null }); // T20: НЕ е изпратена
    expect(b.followUps[0]).toMatchObject({ kind: "OFFER", offerId: ro.offerId });
    expect(await ctx.db.notificationOutbox.count()).toBe(0); // никакъв имейл

    const rw = await recordOutcome(ctx, { businessId: won, outcome: "WON", idempotencyKey: "idem-o-won-key", deal: { service: "Сайт", oneTimeCents: 70000, monthlyCents: 3500, startDate: "2026-10-07" } });
    b = await biz(won);
    expect(b.pipelineStage).toBe("WON");
    expect(b.client).toMatchObject({ id: rw.clientId, agreedOneTimeCents: 70000 });
    expect(await ctx.db.receivedPayment.count()).toBe(0); // T22

    await createFollowUp(ctx, { businessId: dec, dueAt: later, reason: "Тест причина" });
    await recordOutcome(ctx, { businessId: dec, outcome: "DECLINED", declineReason: "няма бюджет", idempotencyKey: "idem-o-dec-key" });
    b = await biz(dec);
    expect(b.pipelineStage).toBe("LOST");
    expect(b.followUps.every((f) => f.status === "CANCELLED")).toBe(true);

    await recordOutcome(ctx, { businessId: inv, outcome: "INVALID_NUMBER", idempotencyKey: "idem-o-inv-key" });
    b = await biz(inv);
    expect(b.reviewStatus).toBe("NEEDS_CHECK");
    expect(b.suppressions[0]).toMatchObject({ type: "INVALID_PHONE", identifierValue: b.phoneNormalized });

    await createFollowUp(ctx, { businessId: dnc, dueAt: later, reason: "Тест причина" });
    await recordOutcome(ctx, { businessId: dnc, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "idem-o-dnc-key" });
    b = await biz(dnc);
    expect(b.suppressions.filter((s) => s.type === "DNC").length).toBeGreaterThanOrEqual(2); // бизнес + идентификатори
    expect(b.followUps.every((f) => f.status === "CANCELLED")).toBe(true);
    expect(b.pipelineStage).toBe("NEW"); // DNC ≠ LOST
  });

  it("T16 CALL_BACK без дата/час (или без отговор за разговор) се отхвърля", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    await expect(recordOutcome(ctx, { businessId, outcome: "CALL_BACK", callConnected: true, idempotencyKey: "idem-cb-1-key" })).rejects.toThrow(/изисква дата и час/);
    await expect(recordOutcome(ctx, { businessId, outcome: "CALL_BACK", callbackAt: new Date(), idempotencyKey: "idem-cb-2-key" })).rejects.toThrow(/разговор/);
    expect(await ctx.db.activity.count()).toBe(0);
  });

  it("T17 dial intent не е опит и не е разговор", async () => {
    ctx = await testDb({ mode: "real" });
    const { businessId } = await addLead(ctx, { phone: "0885000001", isDemo: false });
    const r = await recordDialIntent(ctx, businessId, "idem-dial-1-key");
    expect(r.tel).toBe("tel:+359885000001");
    const day = localDateOf(ctx.clock.now());
    const s = await computeStats(ctx.db, { from: day, to: day });
    expect(s.counts.attempts).toBe(0);
    expect(s.counts.conversations).toBe(0);
    expect((await biz(businessId)).pipelineStage).toBe("NEW");
    // demo: без реално набиране
    const dctx = await testDb();
    const d = await addLead(dctx);
    await expect(recordDialIntent(dctx, d.businessId, "idem-dial-2-key")).rejects.toThrow(DomainError);
    await closeDb(dctx);
  });

  it("T18 „Запази и следващ“ с retry не създава двойна Activity", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    const input = { businessId, outcome: "SEND_OFFER" as const, idempotencyKey: "same-key-123" };
    const [a, b2] = await Promise.all([recordOutcome(ctx, input), recordOutcome(ctx, input)]);
    const c = await recordOutcome(ctx, input);
    expect(new Set([a.activityId, b2.activityId, c.activityId]).size).toBe(1);
    expect([a, b2, c].filter((x) => x.duplicate)).toHaveLength(2);
    expect(await ctx.db.activity.count()).toBe(1);
    expect(await ctx.db.offer.count()).toBe(1);
  });

  it("T19 DNC блокира бъдещ outreach и на backend", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    const r = await recordOutcome(ctx, { businessId, outcome: "SEND_OFFER", idempotencyKey: "idem-d-1-key" });
    await recordOutcome(ctx, { businessId, outcome: "DO_NOT_CONTACT", callConnected: false, idempotencyKey: "idem-d-2-key" });
    await expect(recordOutcome(ctx, { businessId, outcome: "SPOKE", idempotencyKey: "idem-d-3-key" })).rejects.toThrow(/Не се свързвай/);
    await expect(createFollowUp(ctx, { businessId, dueAt: new Date(), reason: "Тест причина" })).rejects.toThrow(/DNC|Не се свързвай/);
    await expect(setOfferStatus(ctx, r.offerId!, { status: "SENT" })).rejects.toThrow(/Не се свързвай|DNC/);
    expect(await ctx.db.followUp.count({ where: { businessId, status: "OPEN" } })).toBe(0);
  });

  it("T21 WON е idempotent; последващ NO_ANSWER не връща WON в NEW; ръчно не може да се върне", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    const deal = { service: "Сайт", oneTimeCents: 50000, startDate: "2026-10-07" };
    await recordOutcome(ctx, { businessId, outcome: "WON", deal, idempotencyKey: "idem-w-1-key" });
    await recordOutcome(ctx, { businessId, outcome: "WON", deal: { ...deal, oneTimeCents: 99999 }, idempotencyKey: "idem-w-2-key" });
    expect(await ctx.db.client.count()).toBe(1);
    expect((await ctx.db.client.findFirstOrThrow()).agreedOneTimeCents).toBe(50000);
    await recordOutcome(ctx, { businessId, outcome: "NO_ANSWER", idempotencyKey: "idem-w-3-key" });
    expect((await biz(businessId)).pipelineStage).toBe("WON");
    await expect(moveStage(ctx, { businessId, toStage: "CONTACTED" })).rejects.toThrow(/Спечелен/);
  });

  it("T22 приета оферта не е получено плащане", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    const r = await recordOutcome(ctx, { businessId, outcome: "SEND_OFFER", idempotencyKey: "idem-p-1-key" });
    await setOfferStatus(ctx, r.offerId!, { status: "SENT" });
    await setOfferStatus(ctx, r.offerId!, { status: "ACCEPTED" });
    const day = localDateOf(ctx.clock.now());
    const s = await computeStats(ctx.db, { from: day, to: day });
    expect(s.counts.offersAccepted).toBe(1);
    expect(s.money.receivedCents).toBe(0);
    expect(s.counts.won).toBe(0); // клиент се създава само с изричен WON
  });

  it("контакт извън телефона не увеличава call count", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx);
    await recordOutcome(ctx, { businessId, outcome: "INTERESTED", channel: "OTHER", idempotencyKey: "idem-x-1-key" });
    const day = localDateOf(ctx.clock.now());
    const s = await computeStats(ctx.db, { from: day, to: day });
    expect(s.counts.attempts).toBe(0);
    expect(s.counts.otherContacts).toBe(1);
    expect((await biz(businessId)).pipelineStage).toBe("QUALIFIED");
  });
});

describe("T23 статистиката съвпада с известни fixture totals", () => {
  it("точни броячи и знаменатели", async () => {
    ctx = await testDb();
    const ids = await Promise.all(Array.from({ length: 6 }, () => addLead(ctx).then((r) => r.businessId)));
    const [a, b, c, d, e, f] = ids as [string, string, string, string, string, string];
    await recordOutcome(ctx, { businessId: a, outcome: "NO_ANSWER", idempotencyKey: "idem-s1-key" });
    await recordOutcome(ctx, { businessId: a, outcome: "SPOKE", idempotencyKey: "idem-s2-key" });
    await recordOutcome(ctx, { businessId: b, outcome: "INTERESTED", idempotencyKey: "idem-s3-key" });
    await recordOutcome(ctx, { businessId: c, outcome: "SEND_OFFER", idempotencyKey: "idem-s4-key" });
    await recordOutcome(ctx, { businessId: d, outcome: "WON", deal: { service: "Сайт тест", oneTimeCents: 100000, monthlyCents: 2000, startDate: "2026-10-07" }, idempotencyKey: "idem-s5-key" });
    await recordOutcome(ctx, { businessId: e, outcome: "INVALID_NUMBER", idempotencyKey: "idem-s6-key" });
    await recordOutcome(ctx, { businessId: f, outcome: "DECLINED", declineReason: "не", idempotencyKey: "idem-s7-key" });
    await ctx.db.activity.create({ data: { businessId: b, type: "MEETING", note: "среща", occurredAt: ctx.clock.now() } });
    await ctx.db.activity.create({ data: { businessId: b, type: "DIAL_INTENT", occurredAt: ctx.clock.now() } });
    const client = await ctx.db.client.findFirstOrThrow();
    await ctx.db.receivedPayment.create({ data: { clientId: client.id, amountCents: 30000, receivedOn: localDateOf(ctx.clock.now()) } });
    const day = localDateOf(ctx.clock.now());
    const s = await computeStats(ctx.db, { from: day, to: day });
    expect(s.counts).toMatchObject({ attempts: 7, conversations: 5, interested: 3, meetings: 1, offersCreated: 1, won: 1 });
    expect(s.money).toEqual({ agreedOneTimeCents: 100000, agreedMonthlyCents: 2000, receivedCents: 30000 });
    const connect = s.rates.find((r) => r.label === "Свързване")!;
    expect([connect.num, connect.den]).toEqual([5, 7]);
    expect(connect.sample).toBe("small");
    const empty = await computeStats(ctx.db, { from: "2020-01-01", to: "2020-01-02" });
    expect(empty.rates.every((r) => r.value === null && r.sample === "none")).toBe(true);
  });
});
