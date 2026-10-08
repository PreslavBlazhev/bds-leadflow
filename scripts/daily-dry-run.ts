import { scriptCtx, run } from "./_ctx";
import { previewSelection } from "../src/domain/batch";
import { addDays, localDateOf } from "../src/lib/time";

/** Показва какво БИ избрал дневният job — само четене, без reservation, outbox или доставки. */
run(async () => {
  const ctx = await scriptCtx("dry-run");
  const arg = process.argv.find((a) => a.startsWith("--date="))?.slice(7);
  const today = localDateOf(ctx.clock.now());
  const hasToday = await ctx.db.dailyBatch.findUnique({ where: { localDate: today } });
  const date = arg ?? (hasToday ? addDays(today, 1) : today);
  const p = await previewSelection(ctx.db, ctx.mode, ctx.clock.now(), date);
  console.log(`DRY-RUN за ${date} (режим ${ctx.mode}) — без записи в DB.`);
  console.log(`Допустим резерв: ${p.poolSize}; вече издадени за датата: ${p.existingCount}; биха се избрали: ${p.items.length}/${p.target}`);
  for (const n of p.notes) console.log(`  • ${n}`);
  for (const [k, v] of Object.entries(p.plan)) console.log(`  ${k}: квота ${v.quota}, налични ${v.available}, избрани ${v.taken}`);
  p.items.forEach((it, i) => console.log(`${String(i + 1).padStart(2)}. ${it.ref} ${it.name} — ${it.city} — score ${it.score} — ${it.reason}`));
  await ctx.db.$disconnect();
});
