import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "./_env";
import { createDb, providerOfUrl, sqliteFilePath } from "../src/lib/db";
import { getEnv } from "../src/lib/env";

/**
 * Прилага миграциите (prisma migrate deploy) и маркира режима на базата (SystemMeta).
 * Отказва, ако съществуваща база е от другия режим (fail-closed).
 * PostgreSQL (нова празна база, напр. тестова): prisma/postgresql/migrations + SystemMeta.
 * Production preDeploy използва само `npm run db:deploy` (миграции, без данни) — данните идват от преноса.
 */
export async function migrate(): Promise<void> {
  loadDotEnv();
  const env = getEnv();
  if (providerOfUrl(env.DATABASE_URL) === "postgresql") return migratePg(env);
  const file = sqliteFilePath(env.DATABASE_URL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  if (existed) {
    const db = await createDb(env.DATABASE_URL);
    try {
      const rows = (await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type='table' AND name='SystemMeta'`)) as unknown[];
      if (rows.length) await assertModeRaw(db, env.APP_MODE);
    } finally {
      await db.$disconnect();
    }
  }
  const prismaBin = path.resolve("node_modules", "prisma", "build", "index.js");
  try {
    execFileSync(process.execPath, [prismaBin, "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: `file:${file}` } });
  } catch {
    throw new Error("Миграцията не успя. Ако съобщението е „database is locked“ — спри npm run dev / worker и опитай отново.");
  }
  const db = await createDb(env.DATABASE_URL);
  try {
    const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
    if (!meta) await db.systemMeta.create({ data: { id: 1, mode: env.APP_MODE } });
    console.log(`[db] ${path.relative(process.cwd(), file)} — режим ${env.APP_MODE}, миграциите са приложени.`);
  } finally {
    await db.$disconnect();
  }
}

/** Режимът се чете със суров SQL — преди миграцията клиентът може да очаква колони, които още липсват. */
async function assertModeRaw(db: Awaited<ReturnType<typeof createDb>>, mode: string) {
  const rows = (await db.$queryRawUnsafe(`SELECT "mode" FROM "SystemMeta" WHERE "id" = 1`)) as { mode: string }[];
  if (rows[0] && rows[0].mode !== mode) throw new Error(`Отказ: базата е "${rows[0].mode}", а APP_MODE=${mode}.`);
}

async function migratePg(env: ReturnType<typeof getEnv>): Promise<void> {
  const db = await createDb(env.DATABASE_URL);
  try {
    const rows = (await db.$queryRawUnsafe(`SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'SystemMeta'`)) as unknown[];
    if (rows.length) await assertModeRaw(db, env.APP_MODE);
  } finally {
    await db.$disconnect();
  }
  execFileSync(process.execPath, [path.resolve("scripts", "prisma-pg.mjs"), "migrate", "deploy"], { stdio: "inherit", env: process.env });
  const db2 = await createDb(env.DATABASE_URL);
  try {
    const meta = await db2.systemMeta.findUnique({ where: { id: 1 } });
    if (!meta) await db2.systemMeta.create({ data: { id: 1, mode: env.APP_MODE } });
    console.log(`[db] PostgreSQL — режим ${env.APP_MODE}, миграциите са приложени.`);
  } finally {
    await db2.$disconnect();
  }
}

if (process.argv[1]?.endsWith("db-migrate.ts")) {
  migrate().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
