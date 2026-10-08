import { scriptCtx, run } from "./_ctx";
import { seedDemo } from "../src/domain/seed";

run(async () => {
  const ctx = await scriptCtx("seed");
  if (ctx.mode !== "demo") throw new Error("Отказ: db:seed е само за APP_MODE=demo.");
  await seedDemo(ctx, { log: (s) => console.log(`[seed] ${s}`) });
  await ctx.db.$disconnect();
});
