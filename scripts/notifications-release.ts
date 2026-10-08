import { scriptCtx, run } from "./_ctx";
import { localDateOf } from "../src/lib/time";
import { CUTOVER_HOLD } from "../src/domain/migration";

/**
 * Задачи за известия в състояние cutover_hold (пренесени неизпратени) — документирана процедура за live старта.
 *   npm run notifications:release              само показва (без промени)
 *   npm run notifications:release -- --apply   за ДНЕШНАТА местна дата: дневното push известие и резервният имейл
 *                                              се връщат в опашката (ако owner още не е отворил списъка);
 *                                              всичко за минали дати и тестовите → skipped. Нищо старо не се изпраща.
 * Изпълнява се САМО в production базата след проверен cutover и включени DELIVERIES_ENABLED (docs/CUTOVER-AND-ROLLBACK.md).
 */
run(async () => {
  const ctx = await scriptCtx("notifications-release");
  const apply = process.argv.includes("--apply");
  const now = ctx.clock.now();
  const today = localDateOf(now);
  const held = await ctx.db.notificationOutbox.findMany({ where: { status: CUTOVER_HOLD }, orderBy: { createdAt: "asc" } });
  const ack = await ctx.db.dailyAcknowledgement.findUnique({ where: { localDate: today } });
  let released = 0;
  let skipped = 0;
  for (const r of held) {
    const current = r.localDate === today && (r.kind === "DAILY_READY" || r.kind === "FALLBACK_EMAIL") && !ack;
    console.log(`[release] ${r.kind.padEnd(14)} ${r.localDate ?? "—"} → ${current ? "в опашката" : "skipped"}`);
    if (!apply) continue;
    if (current) {
      // Резервният имейл запазва изчисления си час (от действителното публикуване), ако е в бъдещето.
      await ctx.db.notificationOutbox.update({ where: { id: r.id }, data: { status: "queued", notBefore: r.notBefore > now ? r.notBefore : now, lastError: null } });
      released++;
    } else {
      await ctx.db.notificationOutbox.update({ where: { id: r.id }, data: { status: "skipped", lastError: "Пренесено при cutover — не е актуално, не се изпраща." } });
      skipped++;
    }
  }
  if (apply) await ctx.db.auditLog.create({ data: { actor: "cli", action: "notifications.release", details: JSON.stringify({ released, skipped, today }) } });
  console.log(apply ? `[release] върнати в опашката: ${released}, skipped: ${skipped}` : `[release] ${held.length} задачи в ${CUTOVER_HOLD}; без промени (добави --apply).`);
  await ctx.db.$disconnect();
});
