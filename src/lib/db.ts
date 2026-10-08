import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getEnv } from "./env";
import { clientCtor, providerOfUrl, type DbProvider } from "./prismaClients";
import { type Clock, systemClock } from "./time";

export { providerOfUrl, type DbProvider } from "./prismaClients";

export type Mode = "demo" | "real";
export type Tx = Prisma.TransactionClient;
export type DbLike = PrismaClient | Tx;

/** Контекст за application services — един и същ за UI routes, worker, scripts и тестове. */
export interface Ctx {
  db: PrismaClient;
  clock: Clock;
  mode: Mode;
  actor: string;
}

/**
 * SQLite URL → абсолютен път. Относителните пътища в .env са спрямо prisma/ (както ги разбира Prisma CLI),
 * за да сочат към една и съща база от CLI, Next.js, worker-а и scripts.
 * connection_limit=1: SQLite пише сериен; заявките в процеса се подреждат, а между процесите
 * пазят busy_timeout + retry + DB unique constraints.
 */
export function resolveSqliteUrl(url: string, cwd = process.cwd()): string {
  // %LOCALAPPDATA% и др. — real базата живее извън папката на проекта (виж .env.real.example).
  const raw = url.replace(/^file:/, "").replace(/%([A-Z0-9_]+)%/gi, (m, v: string) => process.env[v] ?? m);
  const [p, query] = raw.split("?") as [string, string | undefined];
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, "prisma", p);
  const params = new URLSearchParams(query ?? "");
  if (!params.has("connection_limit")) params.set("connection_limit", "1");
  return `file:${abs.replace(/\\/g, "/")}?${params.toString()}`;
}

export function sqliteFilePath(url: string, cwd = process.cwd()): string {
  if (providerOfUrl(url) !== "sqlite") throw new Error("Тази команда работи само с локална SQLite база (DATABASE_URL=file:…).");
  return resolveSqliteUrl(url, cwd).replace(/^file:/, "").split("?")[0]!;
}

/**
 * PostgreSQL URL: ограничен пул на процес (web/worker/script), timeout-и. Prisma пуска една interactive
 * транзакция на една връзка — advisory/row lock-овете по-долу са обвързани с нея, не с произволна pooled сесия.
 * Ползва се директният (не PgBouncer) connection string на Render; виж docs/RENDER-SETUP.md.
 */
export type DbRole = "web" | "worker" | "script" | "test";
const POOL: Record<DbRole, number> = { web: 5, worker: 3, script: 3, test: 4 };

export function resolvePgUrl(url: string, role: DbRole = "script"): string {
  const u = new URL(url);
  if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", String(POOL[role]));
  if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "20");
  if (!u.searchParams.has("connect_timeout")) u.searchParams.set("connect_timeout", "15");
  return u.toString();
}

const providers = new WeakMap<object, DbProvider>();
/** Provider на клиент или на транзакционен клиент, създаден от tx(). */
export function providerOf(db: DbLike): DbProvider {
  return providers.get(db) ?? "sqlite";
}

export async function createDb(url: string, role: DbRole = "script"): Promise<PrismaClient> {
  const provider = providerOfUrl(url);
  const Ctor = clientCtor(provider);
  if (provider === "postgresql") {
    const db = new Ctor({ datasourceUrl: resolvePgUrl(url, role), log: ["error"] });
    providers.set(db, provider);
    return db;
  }
  const db = new Ctor({ datasourceUrl: resolveSqliteUrl(url), log: ["error"] });
  providers.set(db, provider);
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await db.$queryRawUnsafe("PRAGMA busy_timeout = 8000");
  await db.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  return db;
}

const g = globalThis as unknown as { __lfRaw?: Promise<PrismaClient>; __lfDb?: Promise<PrismaClient> };

/** Връзка без проверка на режима — само за /api/health и /api/ready (празна база преди преноса също отговаря). */
export function getRawDb(): Promise<PrismaClient> {
  if (!g.__lfRaw) {
    g.__lfRaw = createDb(getEnv().DATABASE_URL, "web");
    g.__lfRaw.catch(() => {
      g.__lfRaw = undefined;
    });
  }
  return g.__lfRaw;
}

export function getDb(): Promise<PrismaClient> {
  if (!g.__lfDb) {
    const env = getEnv();
    g.__lfDb = getRawDb().then(async (db) => {
      await assertDbMode(db, env.APP_MODE);
      return db;
    });
    g.__lfDb.catch(() => {
      g.__lfDb = undefined;
    });
  }
  return g.__lfDb;
}

/** Fail-closed: режимът на базата трябва да съвпада с APP_MODE. */
export async function assertDbMode(db: PrismaClient, mode: Mode): Promise<void> {
  const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
  if (!meta) throw new Error("Базата не е инициализирана. Изпълни `npm run setup:demo` (или db:migrate за real).");
  if (meta.mode !== mode) {
    throw new Error(`Базата е създадена за режим "${meta.mode}", а APP_MODE=${mode}. Отказ (fail-closed).`);
  }
}

/** Часовник на приложението. В demo към системното време се добавя demoDayOffset (симулиран следващ ден). */
export async function appClock(db: DbLike, mode: Mode): Promise<Clock> {
  if (mode !== "demo") return systemClock;
  const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
  const offset = (meta?.demoDayOffset ?? 0) * 86_400_000;
  return { now: () => new Date(Date.now() + offset) };
}

export async function getCtx(actor = "owner"): Promise<Ctx> {
  const env = getEnv();
  const db = await getDb();
  return { db, mode: env.APP_MODE, clock: await appClock(db, env.APP_MODE), actor };
}

const errCode = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/**
 * Временни грешки, при които цялата транзакция може безопасно да се повтори:
 * SQLite lock между процеси; PostgreSQL write conflict/deadlock (P2034, 40001, 40P01); изчерпан пул/timeout.
 */
export function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    ["P2034", "P1008", "P2024", "P1001", "P1002", "P1017"].includes(errCode(e)) ||
    /SQLITE_BUSY|database is locked|Timed out fetching|Transaction already closed|could not serialize|deadlock detected|40001|40P01|Can't reach database server|Server has closed the connection/i.test(msg)
  );
}

/**
 * Interactive transaction с ограничени retries (SQLite lock между процеси; PostgreSQL конфликти/deadlock).
 * PostgreSQL: READ COMMITTED + изрични lock-ове (lockKey/lockRow) + DB unique ограничения.
 */
export async function tx<T>(db: PrismaClient, fn: (t: Tx) => Promise<T>, attempts = 5, timeoutMs = 20_000): Promise<T> {
  const provider = providerOf(db);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(
        (t) => {
          providers.set(t, provider);
          return fn(t);
        },
        { maxWait: 10_000, timeout: timeoutMs },
      );
    } catch (e) {
      last = e;
      if (!isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i + Math.random() * 50));
    }
  }
  throw last;
}

/**
 * Сериализира конкурентни транзакции с един и същ ключ (напр. публикуване на дневен списък от web + 2 worker-а).
 * PostgreSQL: pg_advisory_xact_lock — държи се от ТАЗИ транзакция (нейната връзка) и се освобождава при commit/rollback.
 * SQLite: no-op — записите така или иначе са сериализирани (един writer, busy_timeout + retry).
 */
export async function lockKey(t: Tx, key: string): Promise<void> {
  if (providerOf(t) !== "postgresql") return;
  await t.$queryRawUnsafe(`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l`, `leadflow:${key}`);
}

/** Заключва реда на бизнеса до края на транзакцията (PostgreSQL: SELECT … FOR UPDATE; SQLite: no-op). */
export async function lockBusinessRow(t: Tx, businessId: string): Promise<void> {
  if (providerOf(t) !== "postgresql") return;
  await t.$queryRawUnsafe(`SELECT 1 AS locked FROM "Business" WHERE "id" = $1 FOR UPDATE`, businessId);
}

/** P2002 (unique). Проверка по код — двата генерирани клиента имат отделни класове за грешки. */
export function isUniqueViolation(e: unknown): boolean {
  return errCode(e) === "P2002";
}

export async function audit(db: DbLike, actor: string, action: string, entityType?: string, entityId?: string, details: unknown = {}) {
  await db.auditLog.create({ data: { actor, action, entityType, entityId, details: JSON.stringify(details) } });
}

export async function nextRef(db: DbLike): Promise<string> {
  const c = await db.counter.upsert({ where: { name: "business" }, create: { name: "business", value: 1 }, update: { value: { increment: 1 } } });
  return `L-${String(c.value).padStart(6, "0")}`;
}
