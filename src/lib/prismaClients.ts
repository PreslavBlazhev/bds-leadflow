import { createRequire } from "node:module";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

/**
 * Двата Prisma клиента имат идентичен TypeScript API: моделите идват от една схема (prisma/schema.prisma),
 * а prisma/postgresql/schema.prisma се генерира от нея (scripts/prisma-pg-schema.mjs, проверка в CI).
 *  - SQLite: @prisma/client (стандартният изход) — локалната работа.
 *  - PostgreSQL: node_modules/.prisma-pg/client — production. Зарежда се по време на изпълнение (не се bundle-ва
 *    от Next.js), за да намери собствения си query engine до index.js.
 * Provider-ът се избира от схемата на DATABASE_URL (file: / postgresql:), валидирана в src/lib/env.ts —
 * никога от произволна env стойност в статичен schema файл.
 */
export type DbProvider = "sqlite" | "postgresql";

export function providerOfUrl(url: string): DbProvider {
  if (url.startsWith("file:")) return "sqlite";
  if (/^postgres(ql)?:\/\//.test(url)) return "postgresql";
  throw new Error("DATABASE_URL трябва да започва с file: (SQLite, локално) или postgresql:// (production).");
}

type ClientCtor = new (opts: { datasourceUrl: string; log: ("error" | "warn")[] }) => PrismaClient;
let pgCtor: ClientCtor | null = null;

function loadPgCtor(): ClientCtor {
  if (pgCtor) return pgCtor;
  const dir = path.join(process.env.LF_PROJECT_ROOT ?? process.cwd(), "node_modules", ".prisma-pg", "client");
  const req = createRequire(path.join(dir, "noop.js"));
  try {
    pgCtor = (req(dir) as { PrismaClient: ClientCtor }).PrismaClient;
  } catch {
    throw new Error("PostgreSQL Prisma клиентът не е генериран. Изпълни: npm run db:generate");
  }
  return pgCtor;
}

export function clientCtor(provider: DbProvider): ClientCtor {
  return provider === "sqlite" ? (PrismaClient as unknown as ClientCtor) : loadPgCtor();
}
