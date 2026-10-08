import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createDb, type Ctx } from "@/lib/db";
import { fixedClock } from "@/lib/time";
import { DEFAULT_SETTINGS, type Settings } from "@/domain/settings";
import { createPgTestDb, dropPgTestDb, isPgTest } from "./pgTest";

/** url: адресът на тестовата база (file:… или postgresql://…) — за втори клиент/отделен процес. */
export type TestCtx = Ctx & { clock: ReturnType<typeof fixedClock>; file: string; url: string; pgName?: string };
export { isPgTest };

/**
 * Нова изолирана база от мигрирания template + injected clock.
 * SQLite по подразбиране; PostgreSQL при LF_TEST_PG_URL (npm run test:pg) — същите тестове, същият код.
 */
export async function testDb(opts: { now?: string; mode?: "demo" | "real"; settings?: Partial<Settings> } = {}): Promise<TestCtx> {
  let file = "";
  let url: string;
  let pgName: string | undefined;
  if (isPgTest) {
    const pg = await createPgTestDb();
    url = pg.url;
    pgName = pg.name;
  } else {
    const tpl = path.resolve("tests/.tmp/template-test.db");
    file = path.resolve(`tests/.tmp/t-${randomBytes(6).toString("hex")}-test.db`);
    fs.copyFileSync(tpl, file);
    url = `file:${file.split(path.sep).join("/")}`;
  }
  const db = await createDb(url, "test");
  const mode = opts.mode ?? "demo";
  await db.systemMeta.create({ data: { id: 1, mode } });
  await db.appSettings.create({ data: { id: 1, data: JSON.stringify({ ...DEFAULT_SETTINGS, ...opts.settings }) } });
  const clock = fixedClock(opts.now ?? "2026-10-07T05:30:00Z"); // 08:30 Europe/Sofia (EEST)
  return { db, mode, clock, actor: "test", file, url, pgName };
}

export async function closeDb(ctx: { db: PrismaClient; pgName?: string }) {
  await ctx.db.$disconnect();
  if (ctx.pgName) await dropPgTestDb(ctx.pgName);
}

import { tx } from "@/lib/db";
import { ingestCandidate, type CandidateInput } from "@/domain/ingest";

let seq = 0;
/** Чист, допустим кандидат (синтетичен телефон; без мрежа). */
export async function addLead(ctx: TestCtx, o: Partial<CandidateInput> = {}) {
  seq++;
  const n = String(seq).padStart(6, "0");
  return tx(ctx.db, (t) =>
    ingestCandidate(
      t,
      {
        name: `ТЕСТ Бизнес ${n}`,
        city: "Варна",
        category: "restaurant",
        phone: `DEMO-${n}`,
        source: "DEMO",
        sourceUsageConfirmed: true,
        verifiedAt: ctx.clock.now(),
        contactHistoryState: "NONE_CONFIRMED",
        isDemo: true,
        websiteStatus: "UNCHECKED",
        ...o,
      },
      ctx.clock.now(),
    ),
  );
}

export async function addLeads(ctx: TestCtx, count: number, o: Partial<CandidateInput> = {}) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push((await addLead(ctx, o)).businessId);
  return ids;
}
