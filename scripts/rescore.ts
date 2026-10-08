import { scriptCtx, run } from "./_ctx";
import { rescore } from "../src/domain/rescore";

/** Преизчислява кеш колоната score (напр. след ъпгрейд на миграциите). Не променя история/статуси. */
run(async () => {
  const ctx = await scriptCtx("rescore");
  const n = await rescore(ctx.db, ctx.clock.now());
  console.log(`[rescore] ${n} записа проверени.`);
  await ctx.db.$disconnect();
});
