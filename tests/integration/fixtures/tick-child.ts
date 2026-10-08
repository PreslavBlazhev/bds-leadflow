// Отделен Node процес като production worker: един scheduler tick (подготовка + публикуване) срещу тестовата база.
import { createDb } from "../../../src/lib/db";
import { schedulerTick } from "../../../src/domain/scheduler";
import { fixedClock } from "../../../src/lib/time";

const [url, iso, mode] = process.argv.slice(2) as [string, string, "demo" | "real"];
(async () => {
  const db = await createDb(url, "test");
  const r = await schedulerTick({ db, clock: fixedClock(iso), mode, actor: `worker-${process.pid}` }, { owner: `worker-${process.pid}`, discovery: null });
  process.stdout.write(JSON.stringify(r));
  await db.$disconnect();
})().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
