import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { providerOf } from "./db";

/**
 * Съвместимост на кода с базата: приложените миграции трябва да съвпадат ТОЧНО с миграциите в кода
 * (prisma/migrations за SQLite, prisma/postgresql/migrations за PostgreSQL).
 *  - липсваща миграция → новият код чака `db:deploy` (preDeploy стъпката);
 *  - непозната (по-нова) миграция → старият процес не е съвместим и спира работата си до замяната му;
 *  - неуспешна/незавършена миграция → not ready.
 * Web ползва това за /api/ready; worker-ът не обработва задачи, докато schema не е ok.
 */
export interface SchemaStatus {
  ok: boolean;
  expected: number;
  applied: number;
  missing: string[];
  unknown: string[];
  failed: string[];
  latest: string | null;
}

export function migrationsDir(provider: "sqlite" | "postgresql", root = process.env.LF_PROJECT_ROOT ?? process.cwd()): string {
  return provider === "postgresql" ? path.join(root, "prisma", "postgresql", "migrations") : path.join(root, "prisma", "migrations");
}

export function expectedMigrations(provider: "sqlite" | "postgresql"): string[] {
  const dir = migrationsDir(provider);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

export async function schemaStatus(db: PrismaClient): Promise<SchemaStatus> {
  const provider = providerOf(db);
  const expected = expectedMigrations(provider);
  let rows: { migration_name: string; finished: number | boolean | bigint | null; rolled_back: number | boolean | bigint | null }[] = [];
  try {
    rows = await db.$queryRawUnsafe(
      `SELECT migration_name, CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END AS finished, CASE WHEN rolled_back_at IS NULL THEN 0 ELSE 1 END AS rolled_back FROM _prisma_migrations`,
    );
  } catch {
    // Таблицата липсва → празна база, миграциите не са приложени.
    return { ok: false, expected: expected.length, applied: 0, missing: expected, unknown: [], failed: [], latest: null };
  }
  const truthy = (v: unknown) => Number(v) === 1;
  const done = new Set(rows.filter((r) => truthy(r.finished) && !truthy(r.rolled_back)).map((r) => r.migration_name));
  const failed = rows.filter((r) => !truthy(r.finished) && !truthy(r.rolled_back)).map((r) => r.migration_name);
  const missing = expected.filter((m) => !done.has(m));
  const unknown = [...done].filter((m) => !expected.includes(m)).sort();
  return {
    ok: missing.length === 0 && unknown.length === 0 && failed.length === 0,
    expected: expected.length,
    applied: done.size,
    missing,
    unknown,
    failed,
    latest: [...done].sort().at(-1) ?? null,
  };
}
