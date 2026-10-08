// Отделен Node процес (като web + worker), който публикува дневния списък в споделената тестова база.
import { createDb } from "../../../src/lib/db";
import { publishDailyBatch } from "../../../src/domain/batch";
import { fixedClock } from "../../../src/lib/time";

const [url, iso] = process.argv.slice(2) as [string, string]; // file:… (SQLite) или postgresql://…
(async () => {
  const db = await createDb(url, "test");
  const r = await publishDailyBatch({ db, clock: fixedClock(iso), mode: "demo", actor: `child-${process.pid}` }, { trigger: "scheduler" });
  process.stdout.write(JSON.stringify(r));
  await db.$disconnect();
})().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
