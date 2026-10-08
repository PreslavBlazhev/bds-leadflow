import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadDotEnv } from "./_env";
import { createDb, providerOfUrl, sqliteFilePath } from "../src/lib/db";
import { getEnv } from "../src/lib/env";
import { schemaStatus } from "../src/lib/schemaVersion";
import { buildArchive, importArchive, readArchive, archiveId, validateArchive, verifyAgainstArchive, writeArchive } from "../src/domain/migration";
import { activeList } from "../src/domain/activeList";
import { buildCallQueues } from "../src/domain/callQueue";
import { buildEligibilityCtx, eligiblePool } from "../src/domain/eligibility";
import { getSettings } from "../src/domain/settings";

/**
 * Пренос на данните SQLite → PostgreSQL. Подкоманди (npm scripts):
 *   npm run migrate:export                         консистентен snapshot (VACUUM INTO) + архив в backups/migration/<време>/
 *   npm run migrate:dry-run -- --archive <файл>    проверка на архива, без запис
 *   npm run migrate:import  -- --archive <файл>    импорт в TARGET_DATABASE_URL (PostgreSQL), една транзакция
 *   npm run migrate:verify  -- --archive <файл>    независимо сверяване + отчет report.md до архива
 * Целевият адрес е САМО в env TARGET_DATABASE_URL (не в аргументи → не остава в историята на командите).
 * Изходът съдържа само таблици, бройки и PASS/FAIL — без контакти, хешове на пароли или хешове на записи.
 */

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const targetMode = (flag("target-mode") ?? "real") as "real" | "demo";
const redact = (u: string) => u.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");

function target(): string {
  const u = process.env.TARGET_DATABASE_URL;
  if (!u || providerOfUrl(u) !== "postgresql") throw new Error("Задай TARGET_DATABASE_URL=postgresql://… (отделна целева база).");
  if (process.env.DATABASE_URL && u === process.env.DATABASE_URL && process.env.LF_ALLOW_SAME_DB !== "1") {
    // Импортът никога не пише в базата, от която работи локалното приложение.
    throw new Error("TARGET_DATABASE_URL съвпада с DATABASE_URL на локалното приложение — отказ.");
  }
  return u;
}

function archivePath(): string {
  const a = flag("archive");
  if (!a) throw new Error("Нужно е --archive <път до archive.json.gz>");
  return path.resolve(a);
}

async function exportCmd() {
  loadDotEnv();
  const env = getEnv();
  if (providerOfUrl(env.DATABASE_URL) !== "sqlite") throw new Error("Export-ът е от локалната SQLite база (DATABASE_URL=file:…). За PostgreSQL → PostgreSQL използвай pg:backup.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(flag("out") ?? path.join("backups", "migration", stamp));
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = path.join(dir, "snapshot.db");
  // Консистентен snapshot: SQLite VACUUM INTO (транзакционно копие, безопасно при WAL и работещо приложение).
  const live = await createDb(env.DATABASE_URL);
  const snapshotAt = new Date();
  try {
    await live.$executeRawUnsafe(`VACUUM INTO '${snapshot.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    await live.$disconnect();
  }
  const db = await createDb(`file:${snapshot.replace(/\\/g, "/")}`);
  try {
    const a = await buildArchive(db, snapshotAt, "migrate:export");
    const file = path.join(dir, "archive.json.gz");
    const id = writeArchive(file, a);
    const manifest = {
      format: a.format,
      formatVersion: a.formatVersion,
      snapshotAt: a.snapshotAt,
      source: { provider: a.source.provider, appMode: a.source.appMode, file: path.basename(sqliteFilePath(env.DATABASE_URL)), migrations: a.source.migrations.length },
      archive: { file: "archive.json.gz", sha256: id, bytes: fs.statSync(file).size },
      tables: Object.fromEntries(Object.entries(a.tables).map(([k, t]) => [k, t.count])),
      notMigrated: a.notMigrated,
      totals: a.totals,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(`[export] snapshot ${snapshotAt.toISOString()} → ${path.relative(process.cwd(), dir)}`);
    console.log(`[export] таблици ${a.totals.tables}, редове ${a.totals.rows}; архив ${(manifest.archive.bytes / 1024).toFixed(0)} KB`);
    console.log(`[export] архив: ${path.relative(process.cwd(), file)} (id ${id.slice(0, 12)}…). Не го качвай в Git/облак — съдържа CRM данни.`);
  } finally {
    await db.$disconnect();
  }
}

async function dryRunCmd() {
  const file = archivePath();
  const a = readArchive(file);
  const v = validateArchive(a, { targetMode });
  console.log(`[dry-run] архив ${path.basename(path.dirname(file))}/${path.basename(file)} · snapshot ${a.snapshotAt} · формат v${a.formatVersion}`);
  for (const t of v.tables) console.log(`  ${t.name.padEnd(22)} ${t.count}`);
  console.log("[dry-run] трансформации:");
  for (const t of v.transformations) console.log(`  - ${t}`);
  for (const w of v.warnings) console.log(`[dry-run] предупреждение: ${w}`);
  if (!v.ok) {
    for (const e of v.errors) console.error(`[dry-run] ГРЕШКА: ${e}`);
    throw new Error("Архивът НЕ е годен за импорт.");
  }
  if (process.env.TARGET_DATABASE_URL) {
    const db = await createDb(target());
    try {
      const s = await schemaStatus(db);
      const meta = await db.systemMeta.findUnique({ where: { id: 1 } }).catch(() => null);
      const biz = await db.business.count().catch(() => -1);
      console.log(`[dry-run] цел ${redact(target())}: schema ${s.ok ? "OK" : "НЕ Е ГОТОВА"} (${s.applied}/${s.expected}); ${meta?.migratedFromArchive === archiveId(file) ? "вече пренесен ТОЗИ архив (импортът ще е 0 промени)" : biz === 0 && !meta ? "празна" : "НЕ Е ПРАЗНА — импортът ще откаже"}`);
    } finally {
      await db.$disconnect();
    }
  }
  console.log("[dry-run] OK — нищо не е записано.");
}

async function importCmd() {
  const file = archivePath();
  const a = readArchive(file);
  const id = archiveId(file);
  const db = await createDb(target(), "script");
  try {
    const r = await importArchive(db, a, id, { targetMode });
    console.log(
      r.status === "already-imported"
        ? `[import] Този архив вече е пренесен в целевата база — 0 промени. Пусни migrate:verify.`
        : `[import] OK: ${r.rows} реда в ${(r.durationMs / 1000).toFixed(1)} s (една транзакция). Следва: npm run migrate:verify -- --archive …`,
    );
  } finally {
    await db.$disconnect();
  }
}

/* ---------- Бизнес проверки върху двете бази (без лични данни: бройки и съвпадение на набори) ---------- */

const digest = (xs: string[]) => createHash("sha256").update(xs.join("\n")).digest("hex");

async function businessFacts(db: PrismaClient, now: Date) {
  const meta = await db.systemMeta.findUniqueOrThrow({ where: { id: 1 } });
  const s = await getSettings(db);
  const settingsRow = await db.appSettings.findUnique({ where: { id: 1 } });
  const al = await activeList(db, { realOnly: true });
  const pool = await eligiblePool(db, await buildEligibilityCtx(db, meta.mode as "demo" | "real", s, now));
  const q = await buildCallQueues(db, now);
  const owner = await db.user.findFirstOrThrow();
  const sums = async () => ({
    offersOneTime: (await db.offer.aggregate({ _sum: { oneTimeCents: true } }))._sum.oneTimeCents ?? 0,
    offersMonthly: (await db.offer.aggregate({ _sum: { monthlyCents: true } }))._sum.monthlyCents ?? 0,
    clientsAgreed: (await db.client.aggregate({ _sum: { agreedOneTimeCents: true } }))._sum.agreedOneTimeCents ?? 0,
    paymentsReceived: (await db.receivedPayment.aggregate({ _sum: { amountCents: true } }))._sum.amountCents ?? 0,
  });
  return {
    facts: {
      "Бизнеси общо": await db.business.count(),
      "Реални бизнеси": await db.business.count({ where: { isDemo: false } }),
      "Демо бизнеси (история)": await db.business.count({ where: { isDemo: true } }),
      "Прозвънени преди импорта (потвърдено)": await db.business.count({ where: { isDemo: false, priorContact: "CALLED_BEFORE_IMPORT", priorContactSource: "OWNER_CONFIRMATION" } }),
      "Още незвънени (потвърдено)": await db.business.count({ where: { isDemo: false, priorContact: "NOT_CALLED" } }),
      "Реални бизнеси с дата на проверка 2026-09-15": await db.business.count({ where: { isDemo: false, sourceCheckedOn: "2026-09-15" } }),
      "Издадени списъци": await db.dailyBatch.count(),
      "Участия в списъци": await db.dailyBatchItem.count(),
      "Обработени участия": await db.dailyBatchItem.count({ where: { processedAt: { not: null } } }),
      "Реални участия": await db.dailyBatchItem.count({ where: { business: { isDemo: false } } }),
      "Активен реален списък: общо": al.total,
      "Активен реален списък: обработени": al.handled,
      "Активен реален списък: остават": al.remaining,
      "Допустими нови кандидати (сега)": pool.length,
      "Опашка: активен списък": q.queues.new.length,
      "Опашка: повторни/последващи": q.queues.followups.length,
      "Отворени повторни обаждания (RETRY)": await db.followUp.count({ where: { status: "OPEN", kind: "RETRY" } }),
      "Отворени задачи общо": await db.followUp.count({ where: { status: "OPEN" } }),
      "Обаждания/контакти (дейности)": await db.activity.count(),
      "Активни DNC": await db.suppression.count({ where: { type: "DNC", liftedAt: null } }),
      "Блокирани телефони (INVALID_PHONE)": await db.suppression.count({ where: { type: "INVALID_PHONE", liftedAt: null } }),
      "Идентификатори (дедупликация)": await db.businessIdentifier.count(),
      "Оферти": await db.offer.count(),
      "Клиенти": await db.client.count(),
      "Пари (евроцентове)": JSON.stringify(await sums()),
      "Одитни записи (без записа за самия пренос)": await db.auditLog.count({ where: { NOT: { action: "migration.import" } } }),
      "Брояч за референции (L-…)": (await db.counter.findUnique({ where: { name: "business" } }))?.value ?? 0,
      "Настройки: свежест (дни)": s.reserveFreshnessDays,
      "Настройки: дни за нови списъци": s.activeWeekdays.join(","),
      "Настройки: повторно обаждане (работни дни)": s.noAnswerRetryWorkdays,
      "Настройки: източник": s.leadSource,
    } as Record<string, string | number>,
    sets: {
      "Ред на допустимите кандидати": digest(pool.map((c) => c.b.id)),
      "Необработени контакти в активния списък": digest(al.pending.map((p) => `${p.businessId}:${p.localDate}:${p.position}`)),
      "Запис на настройките (JSON)": digest([settingsRow?.data ?? ""]),
      "Owner: потребител и паролен hash": digest([owner.username, owner.passwordHash]),
    } as Record<string, string>,
    batches: (await db.dailyBatch.findMany({ orderBy: { localDate: "asc" }, select: { localDate: true, _count: { select: { items: true } } } })).map((b) => `${b.localDate}:${b._count.items}`),
  };
}

async function verifyCmd() {
  const file = archivePath();
  const a = readArchive(file);
  const id = archiveId(file);
  const snapshot = path.join(path.dirname(file), "snapshot.db");
  const tdb = await createDb(target(), "script");
  const lines: string[] = [];
  const out = (s = "") => {
    lines.push(s);
    console.log(s);
  };
  let ok = true;
  try {
    const schema = await schemaStatus(tdb);
    const v = await verifyAgainstArchive(tdb, a, id);
    out(`# Отчет за пробен пренос SQLite → PostgreSQL`);
    out();
    out(`- Архив: \`${path.basename(path.dirname(file))}/archive.json.gz\`, формат v${a.formatVersion}`);
    out(`- Snapshot (момент на консистентното копие): ${a.snapshotAt}`);
    out(`- Източник: ${a.source.provider}, режим ${a.source.appMode}, миграции ${a.source.migrations.length}`);
    out(`- Цел: PostgreSQL, schema ${schema.ok ? "OK" : "НЕ"} (${schema.applied}/${schema.expected} миграции), последна \`${schema.latest}\``);
    out(`- Проверено на: ${new Date().toISOString()}`);
    out();
    out(`## Таблици (канонични стойности ред по ред)`);
    out();
    out(`| Таблица | Архив | Цел | Стойности |`);
    out(`| --- | ---: | ---: | --- |`);
    for (const t of v.tables) out(`| ${t.name} | ${t.archive} | ${t.target} | ${t.valuesMatch ? "PASS" : "FAIL"}${t.note ? ` (${t.note})` : ""} |`);
    for (const [n, x] of Object.entries(a.notMigrated)) out(`| ${n} | ${x.count} | — | не се пренася: ${x.reason} |`);
    out();
    const orphans = v.orphanChecks.filter((o) => o.orphans > 0);
    out(`## Връзки: ${v.orphanChecks.length} FK проверки със SQL — ${orphans.length === 0 ? "0 осиротели (PASS)" : `FAIL: ${orphans.map((o) => `${o.relation}=${o.orphans}`).join(", ")}`}`);
    out(`## Sequences/autoincrement: ${v.sequences} в целевата схема (ID-тата са текстови cuid; броячът за референции Counter се пренася като данни)`);
    ok = v.ok;
    if (fs.existsSync(snapshot)) {
      const sdb = await createDb(`file:${snapshot.replace(/\\/g, "/")}`);
      try {
        const now = new Date(a.snapshotAt);
        const [src, dst] = [await businessFacts(sdb, now), await businessFacts(tdb, now)];
        out();
        out(`## Бизнес проверки (същият код върху двете бази, часовник = момента на snapshot-а)`);
        out();
        out(`| Проверка | SQLite snapshot | PostgreSQL | |`);
        out(`| --- | --- | --- | --- |`);
        for (const k of Object.keys(src.facts)) {
          const same = String(src.facts[k]) === String(dst.facts[k]);
          ok &&= same;
          out(`| ${k} | ${src.facts[k]} | ${dst.facts[k]} | ${same ? "PASS" : "FAIL"} |`);
        }
        for (const k of Object.keys(src.sets)) {
          const same = src.sets[k] === dst.sets[k];
          ok &&= same;
          out(`| ${k} | (набор) | (набор) | ${same ? "PASS — идентични" : "FAIL"} |`);
        }
        const sameBatches = src.batches.join() === dst.batches.join();
        ok &&= sameBatches;
        out(`| Списъци по местна дата (дата:бройка) | ${src.batches.join(" ")} | ${sameBatches ? "същите" : dst.batches.join(" ")} | ${sameBatches ? "PASS" : "FAIL"} |`);
        const sessions = await tdb.session.count();
        out(`| Сесии в целта (нов вход е нужен) | — | ${sessions} | ${sessions === 0 ? "PASS" : "FAIL"} |`);
        ok &&= sessions === 0;
        const held = await tdb.notificationOutbox.count({ where: { status: "cutover_hold" } });
        out(`| Неизпратени известия → cutover_hold | — | ${held} | INFO |`);
      } finally {
        await sdb.$disconnect();
      }
    } else out(`(snapshot.db липсва до архива — бизнес проверките върху източника са пропуснати)`);
    out();
    out(`## Резултат: ${ok ? "PASS" : "FAIL"}`);
    fs.writeFileSync(path.join(path.dirname(file), "report.md"), lines.join("\n") + "\n");
    console.log(`\n[verify] отчет: ${path.relative(process.cwd(), path.join(path.dirname(file), "report.md"))} (локален, извън Git)`);
  } finally {
    await tdb.$disconnect();
  }
  if (!ok) throw new Error("Сверяването НЕ е успешно.");
}

const cmds: Record<string, () => Promise<void>> = { export: exportCmd, "dry-run": dryRunCmd, import: importCmd, verify: verifyCmd };
const fn = cmd ? cmds[cmd] : undefined;
if (!fn) {
  console.error("Употреба: tsx scripts/migrate-data.ts export|dry-run|import|verify [--archive <файл>] [--target-mode real]");
  process.exit(2);
}
fn().then(
  () => process.exit(0),
  (e) => {
    console.error(`[migrate] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
