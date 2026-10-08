import { scriptCtx, run } from "./_ctx";
import { simulateNextDay } from "../src/domain/demo";

/** Demo-only: премества demo часовника с 1 ден и подготвя/публикува списъка. Без реални доставки. */
run(async () => {
  const ctx = await scriptCtx("demo-next-day");
  const r = await simulateNextDay(ctx);
  console.log(`Симулиран ден ${r.localDate} (offset +${r.offset}): ${r.publish.total}/${r.publish.target} нови. ${r.publish.shortfallReason ?? ""}`);
  await ctx.db.$disconnect();
});
