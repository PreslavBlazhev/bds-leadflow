import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import { loadDotEnv } from "./_env";
import { createDb, providerOfUrl } from "../src/lib/db";
import { schemaStatus } from "../src/lib/schemaVersion";
import { models } from "../src/domain/migration";

/**
 * PostgreSQL backup и проверка на restore (логически dump, custom формат, преносим между машини/версии ≥ сървъра).
 *   npm run pg:backup                               dump на BACKUP_DATABASE_URL (или DATABASE_URL) → backups/pg/
 *   npm run pg:restore-check -- --dump <файл>       restore в RESTORE_DATABASE_URL (ОТДЕЛНА празна база) + сверяване
 * Консистентност: бройките в manifest-а и dump-ът са от ЕДИН и същ snapshot (pg_export_snapshot + pg_dump --snapshot).
 * pg_dump/pg_restore: PG_BIN или PATH; major версията им трябва да е ≥ тази на сървъра (Render: 18).
 * Dump файловете съдържат CRM данни — остават локално/в трайно криптирано хранилище, никога в Git.
 */
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BIN = process.env.PG_BIN ?? (fs.existsSync(path.resolve(".tools/pgsql/bin")) ? path.resolve(".tools/pgsql/bin") : "");
const exe = (n: string) => (BIN ? path.join(BIN, process.platform === "win32" ? `${n}.exe` : n) : n);

/** libpq не приема Prisma параметрите (connection_limit, pool_timeout…) — оставят се само стандартните. */
function libpqUrl(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (!["sslmode", "sslrootcert", "application_name", "connect_timeout"].includes(k)) u.searchParams.delete(k);
  return u.toString();
}

function toolMajor(n: string): number {
  const r = spawnSync(exe(n), ["--version"], { encoding: "utf8" });
  if (r.error) throw new Error(`${n} не е намерен. Задай PG_BIN (папка с ${n}) — виж docs/CUTOVER-AND-ROLLBACK.md.`);
  return Number(/(\d+)(\.\d+)?/.exec(r.stdout)?.[1] ?? 0);
}

async function serverMajor(db: PrismaClient): Promise<number> {
  const [r] = (await db.$queryRawUnsafe(`SELECT current_setting('server_version_num')::int AS v`)) as { v: number }[];
  return Math.floor(Number(r?.v ?? 0) / 10000);
}

async function counts(db: PrismaClient | Prisma.TransactionClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of models()) {
    const [r] = (await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${m.name}"`)) as { n: number }[];
    out[m.name] = Number(r?.n ?? 0);
  }
  return out;
}

function run(bin: string, a: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe(bin), a, { stdio: ["ignore", "inherit", "pipe"], env });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} изход ${code}: ${err.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").slice(0, 500)}`))));
  });
}

async function backup() {
  loadDotEnv();
  const url = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (providerOfUrl(url) !== "postgresql") throw new Error("Нужен е PostgreSQL адрес (BACKUP_DATABASE_URL или DATABASE_URL). За SQLite: npm run backup.");
  const db = await createDb(url, "script");
  try {
    const [srv, dump] = [await serverMajor(db), toolMajor("pg_dump")];
    if (dump < srv) throw new Error(`pg_dump ${dump} е по-стар от сървъра ${srv} — нужен е pg_dump ≥ ${srv}.`);
    const dir = path.resolve(flag("out") ?? path.join("backups", "pg"));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `leadflow-${stamp}.dump`);
    const manifest = await db.$transaction(
      async (t) => {
        const [snap] = (await t.$queryRawUnsafe(`SELECT pg_export_snapshot() AS s`)) as { s: string }[];
        const c = await counts(t);
        const schema = (await t.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)) as { migration_name: string }[];
        await run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snap!.s}`, "--file", file, "--dbname", libpqUrl(url)], process.env);
        return { createdAt: new Date().toISOString(), serverMajor: srv, pgDumpMajor: dump, migrations: schema.map((s) => s.migration_name), counts: c };
      },
      // PostgreSQL клиент; типът на опцията е от общия API.
      { isolationLevel: "RepeatableRead" as Prisma.TransactionIsolationLevel, timeout: 30 * 60_000, maxWait: 30_000 },
    );
    fs.writeFileSync(`${file}.manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(`[pg:backup] ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB), ${Object.values(manifest.counts).reduce((a, b) => a + b, 0)} реда в ${models().length} таблици; manifest до файла.`);
  } finally {
    await db.$disconnect();
  }
}

async function restoreCheck() {
  loadDotEnv();
  const dump = flag("dump");
  if (!dump || !fs.existsSync(dump)) throw new Error("Нужно е --dump <файл.dump> (с .manifest.json до него).");
  const manifest = JSON.parse(fs.readFileSync(`${dump}.manifest.json`, "utf8")) as { counts: Record<string, number>; migrations: string[] };
  const url = process.env.RESTORE_DATABASE_URL ?? "";
  if (providerOfUrl(url) !== "postgresql") throw new Error("Задай RESTORE_DATABASE_URL — ОТДЕЛНА празна PostgreSQL база за проверката.");
  for (const other of [process.env.DATABASE_URL, process.env.BACKUP_DATABASE_URL]) {
    if (other && libpqUrl(other) === libpqUrl(url)) throw new Error("RESTORE_DATABASE_URL съвпада с работната база — отказ.");
  }
  const db = await createDb(url, "script");
  try {
    const [t] = (await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`)) as { n: number }[];
    if (Number(t?.n) > 0) throw new Error("RESTORE_DATABASE_URL не е празна — restore проверката изисква празна база.");
    if (toolMajor("pg_restore") < (await serverMajor(db))) throw new Error("pg_restore е по-стар от сървъра.");
    await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", "--dbname", libpqUrl(url), dump], process.env);
    const got = await counts(db);
    const diff = Object.keys(manifest.counts).filter((k) => manifest.counts[k] !== got[k]);
    const schema = await schemaStatus(db);
    console.log(`[pg:restore-check] таблици ${Object.keys(got).length}, редове ${Object.values(got).reduce((a, b) => a + b, 0)}; schema ${schema.ok ? "OK" : "НЕ"} (${schema.applied}/${schema.expected})`);
    if (diff.length || !schema.ok) throw new Error(`Разлики след restore: ${diff.join(", ") || "schema"}`);
    console.log("[pg:restore-check] PASS — бройките съвпадат с manifest-а (същият snapshot като dump-а).");
  } finally {
    await db.$disconnect();
  }
}

const cmd = args[0];
(cmd === "backup" ? backup() : cmd === "restore-check" ? restoreCheck() : Promise.reject(new Error("Употреба: pg-backup.ts backup|restore-check"))).then(
  () => process.exit(0),
  (e) => {
    console.error(`[pg] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
