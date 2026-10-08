import { audit, type Ctx } from "@/lib/db";
import { addDays, fixedClock, localDateOf, zonedToUtc } from "@/lib/time";
import { insertDemoRecord } from "@/providers/candidates";
import { publishDailyBatch } from "./batch";
import { addActivity, createFollowUp, recordPayment, setOfferStatus } from "./crm";
import { tx } from "@/lib/db";
import { ingestCandidate } from "./ingest";
import { recordOutcome, type OutcomeInput } from "./outcomes";
import { rescore } from "./rescore";
import { DEFAULT_SETTINGS } from "./settings";

export const DEMO_SEED_VERSION = 1;
export const DEMO_BASE_COUNT = 400;

/**
 * Детерминиран, idempotent demo seed. Отказва извън demo. Не изтрива нищо;
 * повторно изпълнение не пипа ръчно записаната работа (маркер seedVersion).
 * Историята за минали дни минава през същите domain services с injected clock.
 */
export async function seedDemo(ctx: Ctx, opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  if (ctx.mode !== "demo") throw new Error("Отказ: seed е само за demo база.");
  const meta = await ctx.db.systemMeta.findUnique({ where: { id: 1 } });
  if (meta?.mode !== "demo") throw new Error("Отказ: базата не е маркирана като demo.");
  const marker = await ctx.db.counter.findUnique({ where: { name: "seedVersion" } });
  if (marker) {
    log(`Seed v${marker.value} вече е приложен — нищо не се променя.`);
    return { skipped: true };
  }
  await ctx.db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: JSON.stringify(DEFAULT_SETTINGS) }, update: {} });

  const now = ctx.clock.now();
  const today = localDateOf(now);
  const seedClock = fixedClock(zonedToUtc(addDays(today, -4), "06:00"));
  const sctx: Ctx = { ...ctx, clock: seedClock, actor: "seed" };

  for (let i = 1; i <= DEMO_BASE_COUNT; i++) await insertDemoRecord(sctx, i);
  log(`${DEMO_BASE_COUNT} синтетични бизнеса.`);
  await ctx.db.counter.upsert({ where: { name: "demoIndex" }, create: { name: "demoIndex", value: 1000 }, update: {} });

  // Специални fixtures: общ телефон (клон), сменен телефон (име+град), неизвестна история.
  await tx(ctx.db, async (t) => {
    const base = { category: "restaurant", source: "DEMO" as const, sourceUsageConfirmed: true, isDemo: true, verifiedAt: seedClock.now() };
    await ingestCandidate(t, { ...base, name: "ДЕМО Пицария Клон Център", city: "Варна", phone: "DEMO-0002", contactHistoryState: "NONE_CONFIRMED", notes: "Fixture: общ телефон с L-000002 → проверка за дубликат" }, seedClock.now());
    await ingestCandidate(t, { ...base, name: "ДЕМО Механа 777", city: "Варна", phone: "DEMO-7770", contactHistoryState: "NONE_CONFIRMED" }, seedClock.now());
    await ingestCandidate(t, { ...base, name: "ДЕМО Механа 777", city: "Варна", phone: "DEMO-7771", contactHistoryState: "NONE_CONFIRMED", notes: "Fixture: същото име+град, различен телефон → проверка" }, seedClock.now());
    await ingestCandidate(t, { ...base, name: "ДЕМО Бистро Неизвестна история", city: "Плевен", phone: "DEMO-7772", contactHistoryState: "UNKNOWN", notes: "Fixture: импорт без история → извън новите" }, seedClock.now());
  });

  // Минали 3 дни: публикувани списъци + записани резултати; останалите са backlog.
  const plans: Record<number, OutcomeInput["outcome"][]> = {
    [-3]: ["NO_ANSWER", "SPOKE", "CALL_BACK", "INTERESTED", "SEND_OFFER", "WON", "DECLINED", "INVALID_NUMBER", "DO_NOT_CONTACT", "NO_ANSWER", "SPOKE", "SEND_OFFER", "INTERESTED", "NO_ANSWER", "WON", "CALL_BACK", "DECLINED", "SPOKE", "NO_ANSWER", "INTERESTED"],
    [-2]: ["NO_ANSWER", "SPOKE", "INTERESTED", "SEND_OFFER", "CALL_BACK", "NO_ANSWER", "DECLINED", "SPOKE", "NO_ANSWER", "INTERESTED", "SEND_OFFER", "NO_ANSWER", "SPOKE", "CALL_BACK", "NO_ANSWER"],
    [-1]: ["NO_ANSWER", "SPOKE", "CALL_BACK", "INTERESTED", "NO_ANSWER", "SPOKE", "DECLINED", "NO_ANSWER", "SEND_OFFER", "SPOKE"],
  };
  let k = 0;
  for (const dayOffset of [-3, -2, -1]) {
    const d = addDays(today, dayOffset);
    seedClock.set(zonedToUtc(d, "08:00"));
    const pub = await publishDailyBatch(sctx, { localDate: d, trigger: "demo" });
    await ctx.db.notificationOutbox.updateMany({ where: { localDate: d }, data: { status: "skipped", lastError: "Seed история — без известие" } });
    await ctx.db.dailyAcknowledgement.upsert({ where: { localDate: d }, create: { localDate: d, via: "seed", at: zonedToUtc(d, "08:10") }, update: {} });
    const items = await ctx.db.dailyBatchItem.findMany({ where: { batchId: pub.batchId }, orderBy: { position: "asc" } });
    const outcomes = plans[dayOffset]!;
    for (let j = 0; j < outcomes.length && j < items.length; j++) {
      const o = outcomes[j]!;
      seedClock.set(zonedToUtc(d, `${String(10 + Math.floor(j / 4)).padStart(2, "0")}:${String((j % 4) * 12).padStart(2, "0")}`));
      const businessId = items[j]!.businessId;
      const input: OutcomeInput = { businessId, outcome: o, idempotencyKey: `seed-${d}-${j}`, note: `ДЕМО бележка (${o})` };
      if (o === "CALL_BACK") {
        input.callConnected = true;
        // разнообразие: просрочен, днес, предстоящ
        const when = [addDays(today, -1), today, addDays(today, 2)][k++ % 3]!;
        input.callbackAt = zonedToUtc(when, "11:00");
      }
      if (o === "DO_NOT_CONTACT") input.callConnected = true;
      if (o === "NO_ANSWER" && j % 2 === 0) input.retryAt = zonedToUtc(addDays(d, 2), "10:00");
      if (o === "WON") input.deal = { service: "Сайт с дигитално меню (ДЕМО)", oneTimeCents: 70000, monthlyCents: 3500, startDate: d };
      if (o === "DECLINED") input.declineReason = "ДЕМО: няма бюджет в момента";
      const r = await recordOutcome(sctx, input);
      if (o === "SEND_OFFER" && r.offerId && j % 2 === 1) await setOfferStatus(sctx, r.offerId, { status: "SENT" });
      if (o === "INTERESTED" && j === 3) {
        await addActivity(sctx, { businessId, type: "MEETING", note: "ДЕМО среща в офиса", idempotencyKey: `seed-meeting-${d}` });
      }
      if (o === "WON" && r.clientId && dayOffset === -3 && j === 5) {
        await recordPayment(sctx, { clientId: r.clientId, amountCents: 35000, receivedOn: d, note: "ДЕМО аванс 50% (ръчно записан)", idempotencyKey: `seed-pay-${d}` });
      }
    }
  }
  seedClock.set(zonedToUtc(addDays(today, -1), "17:00"));
  const anyBiz = await ctx.db.dailyBatchItem.findFirst({ where: { batch: { localDate: addDays(today, -1) }, business: { lastOutcome: "INTERESTED" } } });
  if (anyBiz) await createFollowUp(sctx, { businessId: anyBiz.businessId, dueAt: zonedToUtc(today, "15:00"), reason: "Изпрати примерни сайтове (ДЕМО)", kind: "NEXT_STEP" });

  await rescore(ctx.db, now);
  await ctx.db.counter.create({ data: { name: "seedVersion", value: DEMO_SEED_VERSION } });
  await audit(ctx.db, "seed", "seed.demo", undefined, undefined, { version: DEMO_SEED_VERSION });
  log("История за 3 минали дни, оферти, клиенти, DNC, follow-ups и fixtures.");
  return { skipped: false };
}
