import { appClock, audit, type Ctx } from "@/lib/db";
import { localDateOf } from "@/lib/time";
import { demoProvider } from "@/providers/candidates";
import { publishDailyBatch } from "./batch";
import { DomainError } from "./errors";
import { processOutbox } from "./notifications";
import { prepareCandidates } from "./scheduler";
import { getSettings } from "./settings";

/** Demo контролите отказват в real режим и на backend (не само скрит бутон). */
export async function assertDemo(ctx: Ctx) {
  const meta = await ctx.db.systemMeta.findUnique({ where: { id: 1 } });
  if (ctx.mode !== "demo" || meta?.mode !== "demo") throw new DomainError("FORBIDDEN", "Demo контролите са забранени в real режим.");
  // „Следващ ден“/демо подготовка биха публикували реални контакти за симулирана дата или биха добавили синтетични записи.
  if ((await getSettings(ctx.db)).leadSource === "REAL")
    throw new DomainError("FORBIDDEN", "Демо контролите са изключени: новите списъци са от реални (импортирани) записи.");
}

export const SIMULATED_TRANSPORTS = { push: null, email: null, pushBlockedReason: "DEMO_MODE", emailBlockedReason: "DEMO_MODE", baseUrl: "" };

/**
 * "Симулирай следващ ден": отделен demo clock (SystemMeta.demoDayOffset), без смяна на системния часовник
 * и без live outbox. Real базата е отделен файл и не се засяга.
 */
export async function simulateNextDay(ctx: Ctx) {
  await assertDemo(ctx);
  const meta = await ctx.db.systemMeta.update({ where: { id: 1 }, data: { demoDayOffset: { increment: 1 } } });
  const clock = await appClock(ctx.db, "demo");
  const dctx: Ctx = { ...ctx, clock };
  const prepared = await prepareCandidates(dctx, demoProvider());
  const publish = await publishDailyBatch(dctx, { trigger: "demo" });
  await processOutbox(dctx, SIMULATED_TRANSPORTS);
  await audit(ctx.db, ctx.actor, "demo.next_day", undefined, undefined, { offset: meta.demoDayOffset });
  return { offset: meta.demoDayOffset, localDate: localDateOf(clock.now()), prepared, publish };
}

export async function demoPrepare(ctx: Ctx) {
  await assertDemo(ctx);
  return prepareCandidates(ctx, demoProvider());
}
