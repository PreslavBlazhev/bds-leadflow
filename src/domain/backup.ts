import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createDb, providerOf } from "@/lib/db";

/**
 * Консистентен SQLite backup чрез VACUUM INTO (безопасно при активен WAL — не е копие на main файла).
 * Restore се доказва върху ОТДЕЛНА временна база; активната никога не се презаписва автоматично.
 */
export async function backupDb(db: PrismaClient, mode: string, dir = path.resolve("backups")): Promise<string> {
  if (providerOf(db) !== "sqlite") throw new Error("PostgreSQL: използвай npm run pg:backup (pg_dump) — виж docs/CUTOVER-AND-ROLLBACK.md.");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${mode}-${stamp}.db`);
  await db.$executeRawUnsafe(`VACUUM INTO '${file.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  return file;
}

export async function dbTotals(db: PrismaClient) {
  const [businesses, activities, batchItems, activeDnc, clients, payments, followUps, offers] = await Promise.all([
    db.business.count(),
    db.activity.count(),
    db.dailyBatchItem.count(),
    db.suppression.count({ where: { type: "DNC", liftedAt: null, identifierType: null } }), // DNC на ниво бизнес
    db.client.count(),
    db.receivedPayment.count(),
    db.followUp.count(),
    db.offer.count(),
  ]);
  return { businesses, activities, batchItems, activeDnc, clients, payments, followUps, offers };
}

/** Възстановява backup в нов временен файл и сравнява totals/history/DNC с източника. */
export async function verifyBackup(source: PrismaClient, backupFile: string) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lf-restore-")), "restore-test.db");
  fs.copyFileSync(backupFile, tmp);
  const restored = await createDb(`file:${tmp.replace(/\\/g, "/")}`);
  try {
    const [a, b] = await Promise.all([dbTotals(source), dbTotals(restored)]);
    const mismatches = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
    return { ok: mismatches.length === 0, source: a, restored: b, mismatches, restoredFile: tmp };
  } finally {
    await restored.$disconnect();
  }
}
