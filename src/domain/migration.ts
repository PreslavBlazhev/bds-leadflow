import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Prisma, type PrismaClient } from "@prisma/client";
import { providerOf, tx } from "@/lib/db";
import { expectedMigrations, schemaStatus } from "@/lib/schemaVersion";
import { DEFAULT_SETTINGS, settingsSchema } from "./settings";
import { OUTCOMES, STAGES } from "./constants";

/**
 * Пренос на данните SQLite → PostgreSQL (и общо: база → база със същата схема).
 *
 *  export   — консистентен snapshot (SQLite VACUUM INTO, безопасно при WAL) → архив .json.gz с версия на формата,
 *             време на snapshot-а, таблици/полета/типове, бройки и канонични SHA-256 проверки.
 *  validate — dry-run: цялост на архива, съвместимост на полетата с целевата схема, връзки (FK), unique, стойности.
 *  import   — в ОТДЕЛНА PostgreSQL база, в една транзакция (всичко или нищо). Изисква празна целева база;
 *             повторение със същия архив → проверка и 0 промени; друг архив върху непразна база → отказ преди промяна.
 *  verify   — независимо сверяване: каноничните стойности на всеки ред (след документираните трансформации),
 *             осиротели връзки със SQL, и бизнес проверки върху двете бази.
 *
 * Логове/отчети: само имена на таблици, бройки и PASS/FAIL — без лични данни, хешове на пароли или хешове на записи.
 */

export const FORMAT = "bds-leadflow-export";
export const FORMAT_VERSION = 1;

/** Не се пренасят: активните сесии (нов вход в production) и heartbeat-ите на локалните процеси. */
export const NOT_MIGRATED: Record<string, string> = {
  Session: "Активните локални сесии не се активират в production — нов вход със същата парола.",
  WorkerHeartbeat: "Оперативно състояние на локалните процеси.",
};

/** Изходящи известия, които не са изпратени към момента на snapshot-а → cutover_hold (не се изпращат автоматично). */
export const PENDING_OUTBOX = ["queued", "retry_scheduled", "processing"];
export const CUTOVER_HOLD = "cutover_hold";

type Field = { name: string; type: string; isRequired: boolean; isId: boolean; isUnique: boolean };
interface ModelInfo {
  name: string;
  fields: Field[];
  key: string[];
  uniques: string[][];
  relations: { fields: string[]; target: string; targetFields: string[]; required: boolean }[];
}

const delegate = (db: PrismaClient | Prisma.TransactionClient, model: string) =>
  (db as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]>; createMany: (a: unknown) => Promise<{ count: number }>; count: (a?: unknown) => Promise<number>; update: (a: unknown) => Promise<unknown> }>)[
    model[0]!.toLowerCase() + model.slice(1)
  ]!;

export function models(): ModelInfo[] {
  return Prisma.dmmf.datamodel.models.map((m) => {
    const scalars = m.fields.filter((f) => f.kind === "scalar");
    const id = scalars.filter((f) => f.isId).map((f) => f.name);
    return {
      name: m.name,
      fields: scalars.map((f) => ({ name: f.name, type: f.type, isRequired: f.isRequired, isId: f.isId, isUnique: f.isUnique })),
      key: id.length ? id : (m.primaryKey?.fields ?? []).slice(),
      uniques: [...scalars.filter((f) => f.isUnique).map((f) => [f.name]), ...m.uniqueFields.map((u) => [...u])],
      relations: m.fields
        .filter((f) => f.kind === "object" && (f.relationFromFields?.length ?? 0) > 0)
        .map((f) => ({ fields: [...f.relationFromFields!], target: f.type, targetFields: [...(f.relationToFields ?? [])], required: f.isRequired })),
    };
  });
}

/** Ред за вмъкване: първо таблиците, към които се сочи (самовръзката Business.mergedIntoId се попълва във втора стъпка). */
export function insertOrder(ms = models()): ModelInfo[] {
  const byName = new Map(ms.map((m) => [m.name, m]));
  const done = new Set<string>();
  const out: ModelInfo[] = [];
  const visit = (m: ModelInfo, stack: Set<string>) => {
    if (done.has(m.name) || stack.has(m.name)) return;
    stack.add(m.name);
    for (const r of m.relations) if (r.target !== m.name) visit(byName.get(r.target)!, stack);
    done.add(m.name);
    out.push(m);
  };
  for (const m of [...ms].sort((a, b) => a.name.localeCompare(b.name))) visit(m, new Set());
  return out;
}

/* ---------------- Канонично представяне ---------------- */

/** Логическа стойност, независима от базата: DateTime → ISO UTC с милисекунди; числа/булеви/текст — както са; null. */
export function canonical(type: string, v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "DateTime":
      return (v instanceof Date ? v : new Date(String(v))).toISOString();
    case "Boolean":
      return Boolean(v);
    case "Int":
    case "Float":
      if (typeof v === "bigint") return Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Нечислова стойност за ${type}`);
      return v;
    case "String":
      return String(v);
    default:
      throw new Error(`Неподдържан тип ${type} — добави канонично представяне преди преноса.`);
  }
}

export function fromCanonical(type: string, v: unknown): unknown {
  if (v === null) return null;
  return type === "DateTime" ? new Date(String(v)) : v;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const keyOf = (m: ModelInfo, r: Record<string, unknown>) => m.key.map((k) => String(r[k])).join("\u0000");
export const rowDigest = (row: unknown[]) => sha(JSON.stringify(row));
export const tableDigest = (rows: unknown[][]) => sha(rows.map(rowDigest).join("\n"));

export interface ArchiveTable {
  fields: { name: string; type: string; nullable: boolean }[];
  count: number;
  sha256: string;
  rows: unknown[][];
}
export interface Archive {
  format: typeof FORMAT;
  formatVersion: number;
  snapshotAt: string;
  createdBy: string;
  source: { provider: string; appMode: string; migrations: string[] };
  notMigrated: Record<string, { count: number; reason: string }>;
  tables: Record<string, ArchiveTable>;
  totals: { tables: number; rows: number };
}

async function readTable(db: PrismaClient, m: ModelInfo): Promise<unknown[][]> {
  const rows = await delegate(db, m.name).findMany({});
  rows.sort((a, b) => (keyOf(m, a) < keyOf(m, b) ? -1 : keyOf(m, a) > keyOf(m, b) ? 1 : 0));
  return rows.map((r) => m.fields.map((f) => canonical(f.type, r[f.name])));
}

/** Чете ЦЯЛАТА база (snapshot копие) в архив. Само четене. */
export async function buildArchive(db: PrismaClient, snapshotAt: Date, createdBy: string): Promise<Archive> {
  const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
  if (!meta) throw new Error("Източникът не е инициализиран (липсва SystemMeta).");
  const migrations = (
    (await db.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)) as { migration_name: string }[]
  ).map((r) => r.migration_name);
  const tables: Archive["tables"] = {};
  const notMigrated: Archive["notMigrated"] = {};
  let total = 0;
  for (const m of models()) {
    if (NOT_MIGRATED[m.name]) {
      notMigrated[m.name] = { count: await delegate(db, m.name).count(), reason: NOT_MIGRATED[m.name]! };
      continue;
    }
    const rows = await readTable(db, m);
    tables[m.name] = { fields: m.fields.map((f) => ({ name: f.name, type: f.type, nullable: !f.isRequired })), count: rows.length, sha256: tableDigest(rows), rows };
    total += rows.length;
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    snapshotAt: snapshotAt.toISOString(),
    createdBy,
    source: { provider: providerOf(db), appMode: meta.mode, migrations },
    notMigrated,
    tables,
    totals: { tables: Object.keys(tables).length, rows: total },
  };
}

export function writeArchive(file: string, a: Archive): string {
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(a), "utf8"), { level: 9 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return archiveId(file);
}

export function archiveId(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function readArchive(file: string): Archive {
  let json: string;
  try {
    json = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  } catch {
    throw new Error("Архивът е повреден (gzip не може да се разархивира).");
  }
  try {
    return JSON.parse(json) as Archive;
  } catch {
    throw new Error("Архивът е повреден (невалиден JSON).");
  }
}

/* ---------------- Валидиране (dry-run) ---------------- */

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  tables: { name: string; count: number }[];
  transformations: string[];
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Пълна проверка на архива спрямо текущата схема. Не пише нищо. */
export function validateArchive(a: Archive, opts: { targetMode: "real" | "demo" }): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const transformations: string[] = [];
  if (a.format !== FORMAT) errors.push("Непознат формат на архива.");
  if (a.formatVersion !== FORMAT_VERSION) errors.push(`Неподдържана версия на формата: ${a.formatVersion} (очаква се ${FORMAT_VERSION}).`);
  if (!a.snapshotAt || Number.isNaN(Date.parse(a.snapshotAt))) errors.push("Липсва време на snapshot-а.");
  if (errors.length) return { ok: false, errors, warnings, tables: [], transformations };

  // Миграциите на източника трябва да са точно тези в кода (същата логическа схема).
  const want = expectedMigrations(a.source.provider === "postgresql" ? "postgresql" : "sqlite");
  const have = a.source.migrations;
  if (want.length !== have.length || want.some((m, i) => m !== have[i])) {
    errors.push(`Схемата на източника не съвпада с кода (${have.length} приложени миграции, очакват се ${want.length}). Обнови източника (db:migrate) и направи нов export.`);
  }

  const ms = models();
  const index = new Map<string, Map<string, unknown[]>>();
  for (const m of ms) {
    if (NOT_MIGRATED[m.name]) continue;
    const t = a.tables[m.name];
    if (!t) {
      errors.push(`Липсва таблица ${m.name}.`);
      continue;
    }
    const names = t.fields.map((f) => `${f.name}:${f.type}:${f.nullable}`).join(",");
    const expected = m.fields.map((f) => `${f.name}:${f.type}:${!f.isRequired}`).join(",");
    if (names !== expected) {
      errors.push(`Полетата на ${m.name} не съвпадат със схемата.`);
      continue;
    }
    if (t.rows.length !== t.count) errors.push(`${m.name}: бройката не съвпада (${t.rows.length} ≠ ${t.count}).`);
    if (tableDigest(t.rows) !== t.sha256) errors.push(`${m.name}: контролната сума не съвпада — архивът е променен или повреден.`);
    const map = new Map<string, unknown[]>();
    for (const row of t.rows) {
      if (!Array.isArray(row) || row.length !== m.fields.length) {
        errors.push(`${m.name}: ред с грешен брой полета.`);
        break;
      }
      m.fields.forEach((f, i) => {
        const v = row[i];
        if (v === null) {
          if (f.isRequired) errors.push(`${m.name}.${f.name}: липсва задължителна стойност.`);
          return;
        }
        const okType =
          f.type === "DateTime" ? typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v
          : f.type === "Boolean" ? typeof v === "boolean"
          : f.type === "Int" ? Number.isInteger(v)
          : f.type === "Float" ? typeof v === "number" && Number.isFinite(v)
          : typeof v === "string";
        if (!okType) errors.push(`${m.name}.${f.name}: невалиден тип стойност.`);
      });
      const k = m.key.map((kf) => String(row[m.fields.findIndex((f) => f.name === kf)])).join("\u0000");
      if (map.has(k)) errors.push(`${m.name}: дублиран първичен ключ.`);
      map.set(k, row);
    }
    // Unique ограничения (NULL не участва).
    for (const u of m.uniques) {
      const idx = u.map((n) => m.fields.findIndex((f) => f.name === n));
      const seen = new Set<string>();
      for (const row of t.rows) {
        const vals = idx.map((i) => row[i]);
        if (vals.some((v) => v === null)) continue;
        const key = JSON.stringify(vals);
        if (seen.has(key)) {
          errors.push(`${m.name}: нарушено уникално ограничение (${u.join(", ")}).`);
          break;
        }
        seen.add(key);
      }
    }
    index.set(m.name, map);
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 50), warnings, tables: [], transformations };

  // Връзки: всяка ненулева FK стойност сочи съществуващ ред.
  for (const m of ms) {
    const t = a.tables[m.name];
    if (!t) continue;
    for (const r of m.relations) {
      const target = index.get(r.target);
      if (!target) {
        if (NOT_MIGRATED[r.target]) continue;
        errors.push(`${m.name} → ${r.target}: липсва целева таблица.`);
        continue;
      }
      const tm = ms.find((x) => x.name === r.target)!;
      const pos = r.fields.map((n) => m.fields.findIndex((f) => f.name === n));
      const tkeyIsPk = r.targetFields.join() === tm.key.join();
      let orphans = 0;
      for (const row of t.rows) {
        const vals = pos.map((i) => row[i]);
        if (vals.some((v) => v === null)) continue;
        if (tkeyIsPk ? !target.has(vals.map(String).join("\u0000")) : true) orphans++;
      }
      if (orphans) errors.push(`${m.name}.${r.fields.join(",")} → ${r.target}: ${orphans} осиротели връзки.`);
    }
  }

  // Бизнес стойности (същите правила като PostgreSQL CHECK ограниченията).
  const col = (table: string, field: string) => {
    const t = a.tables[table]!;
    const i = t.fields.findIndex((f) => f.name === field);
    return t.rows.map((r) => r[i]);
  };
  const bad = (table: string, field: string, ok: (v: unknown) => boolean) => {
    const n = col(table, field).filter((v) => !ok(v)).length;
    if (n) errors.push(`${table}.${field}: ${n} невалидни стойности.`);
  };
  bad("DailyBatch", "localDate", (v) => typeof v === "string" && LOCAL_DATE.test(v));
  bad("DailyBatchItem", "processedOutcome", (v) => v === null || (OUTCOMES as readonly string[]).includes(String(v)));
  bad("Business", "pipelineStage", (v) => (STAGES as readonly string[]).includes(String(v)));
  bad("Business", "status", (v) => ["ACTIVE", "ARCHIVED", "CLOSED"].includes(String(v)));
  bad("FollowUp", "status", (v) => ["OPEN", "DONE", "CANCELLED"].includes(String(v)));
  bad("FollowUp", "kind", (v) => ["RETRY", "CALL_BACK", "OFFER", "NEXT_STEP", "GENERAL"].includes(String(v)));
  bad("Suppression", "type", (v) => ["DNC", "INVALID_PHONE"].includes(String(v)));
  bad("NotificationOutbox", "channel", (v) => ["PUSH", "EMAIL"].includes(String(v)));
  const settings = col("AppSettings", "data");
  for (const s of settings) {
    try {
      // Както getSettings(): липсващите (по-нови) полета се допълват от defaults; записаните стойности се пазят.
      const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(JSON.parse(String(s)) as object) });
      if (!parsed.success) warnings.push("AppSettings.data не минава Zod проверката — приложението би използвало стойностите по подразбиране (провери Настройки в източника).");
    } catch {
      errors.push("AppSettings.data не е валиден JSON.");
    }
  }
  const meta = a.tables.SystemMeta!.rows;
  if (meta.length !== 1) errors.push("SystemMeta трябва да има точно един ред.");
  const mf = a.tables.SystemMeta!.fields.map((f) => f.name);
  const offset = meta[0]?.[mf.indexOf("demoDayOffset")];
  if (offset !== 0) errors.push("demoDayOffset ≠ 0 (симулиран ден) — върни демо часовника към днес преди export.");
  const users = a.tables.User!.rows.length;
  if (users !== 1) errors.push(`Очаква се точно един owner (има ${users}).`);

  // Документирани трансформации.
  const srcMode = meta[0]?.[mf.indexOf("mode")];
  if (srcMode !== opts.targetMode) transformations.push(`SystemMeta.mode: "${String(srcMode)}" → "${opts.targetMode}" (production работи в real режим; демо записите остават isDemo=true и не влизат в реалните опашки).`);
  transformations.push("SystemMeta.migratedFromArchive/migratedAt: попълват се с идентификатора на архива и момента на импорта.");
  const ob = a.tables.NotificationOutbox!;
  const si = ob.fields.findIndex((f) => f.name === "status");
  const pending = ob.rows.filter((r) => PENDING_OUTBOX.includes(String(r[si]))).length;
  transformations.push(`NotificationOutbox: ${pending} неизпратени задачи → "${CUTOVER_HOLD}" (не се изпращат автоматично; историята остава).`);
  const ps = a.tables.PushSubscription!.rows.length;
  transformations.push(`PushSubscription: ${ps} локални абонамента се пазят като история, но се маркират revokedAt (обвързани са с локалния origin/VAPID ключ) — нова регистрация от телефона.`);
  for (const [name, n] of Object.entries(a.notMigrated)) transformations.push(`${name}: ${n.count} реда не се пренасят — ${n.reason}`);

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)].slice(0, 50),
    warnings,
    tables: Object.entries(a.tables).map(([name, t]) => ({ name, count: t.count })),
    transformations,
  };
}

/* ---------------- Импорт ---------------- */

export interface ImportResult {
  status: "imported" | "already-imported";
  archiveId: string;
  rows: number;
  durationMs: number;
}

/** Таблици, които може да не са празни в целевата база преди импорта (оперативни, не се пренасят). */
const ALLOWED_NONEMPTY = new Set(["WorkerHeartbeat"]);

function transformRow(table: string, fields: ArchiveTable["fields"], row: unknown[], ctx: { targetMode: string; archiveId: string; importedAt: Date }): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  fields.forEach((f, i) => (o[f.name] = fromCanonical(f.type, row[i])));
  if (table === "SystemMeta") {
    o.mode = ctx.targetMode;
    o.migratedFromArchive = ctx.archiveId;
    o.migratedAt = ctx.importedAt;
  }
  if (table === "NotificationOutbox" && PENDING_OUTBOX.includes(String(o.status))) {
    o.status = CUTOVER_HOLD;
    o.leaseUntil = null;
    o.lastError = `Пренесено при cutover (${ctx.importedAt.toISOString()}) — не се изпраща автоматично.`;
  }
  if (table === "PushSubscription" && !o.revokedAt) o.revokedAt = ctx.importedAt;
  return o;
}

export async function importArchive(db: PrismaClient, a: Archive, id: string, opts: { targetMode: "real" | "demo"; now?: Date }): Promise<ImportResult> {
  const started = Date.now();
  if (providerOf(db) !== "postgresql") throw new Error("Импортът е само към PostgreSQL база.");
  const schema = await schemaStatus(db);
  if (!schema.ok) throw new Error(`Целевата схема не е готова (липсващи миграции: ${schema.missing.length}, непознати: ${schema.unknown.length}). Изпълни npm run db:deploy.`);
  const v = validateArchive(a, opts);
  if (!v.ok) throw new Error(`Архивът не мина проверката:\n - ${v.errors.join("\n - ")}`);

  const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
  if (meta?.migratedFromArchive === id) return { status: "already-imported", archiveId: id, rows: 0, durationMs: Date.now() - started };

  const nonEmpty: string[] = [];
  for (const m of models()) {
    if (ALLOWED_NONEMPTY.has(m.name)) continue;
    if ((await delegate(db, m.name).count()) > 0) nonEmpty.push(m.name);
  }
  if (nonEmpty.length) {
    throw new Error(
      meta?.migratedFromArchive
        ? "Целевата база вече съдържа ДРУГ пренесен архив. Отказ преди промяна — за нов пренос използвай нова празна база (виж docs/CUTOVER-AND-ROLLBACK.md)."
        : `Целевата база не е празна (${nonEmpty.join(", ")}). Отказ преди промяна.`,
    );
  }

  const importedAt = opts.now ?? new Date();
  const ctx = { targetMode: opts.targetMode, archiveId: id, importedAt };
  let rows = 0;
  await tx(
    db,
    async (t) => {
      for (const m of insertOrder()) {
        const tab = a.tables[m.name];
        if (!tab || tab.rows.length === 0) continue;
        const selfRef = m.relations.filter((r) => r.target === m.name).flatMap((r) => r.fields);
        const data = tab.rows.map((r) => transformRow(m.name, tab.fields, r, ctx));
        const deferred = data.filter((d) => selfRef.some((f) => d[f] !== null && d[f] !== undefined));
        const first = selfRef.length ? data.map((d) => ({ ...d, ...Object.fromEntries(selfRef.map((f) => [f, null])) })) : data;
        for (let i = 0; i < first.length; i += 500) rows += (await delegate(t, m.name).createMany({ data: first.slice(i, i + 500) })).count;
        for (const d of deferred) {
          await delegate(t, m.name).update({ where: Object.fromEntries(m.key.map((k) => [k, d[k]])), data: Object.fromEntries(selfRef.map((f) => [f, d[f]])) });
        }
      }
      await t.auditLog.create({
        data: { actor: "migration", action: "migration.import", entityType: "SystemMeta", details: JSON.stringify({ archiveId: id, snapshotAt: a.snapshotAt, rows, transformations: v.transformations.length }), at: importedAt },
      });
    },
    1,
    10 * 60_000,
  );
  return { status: "imported", archiveId: id, rows, durationMs: Date.now() - started };
}

/* ---------------- Независимо сверяване ---------------- */

export interface TableCheck {
  name: string;
  archive: number;
  target: number;
  valuesMatch: boolean;
  note?: string;
}

/**
 * Сравнява всяка таблица ред по ред в каноничен вид (архивът с документираните трансформации ↔ прочетеното от
 * целевата база). Чете целевата база наново — не разчита на резултата от импорта.
 */
export async function verifyAgainstArchive(db: PrismaClient, a: Archive, id: string): Promise<{ ok: boolean; tables: TableCheck[]; orphanChecks: { relation: string; orphans: number }[]; sequences: number }> {
  const meta = await db.systemMeta.findUnique({ where: { id: 1 } });
  if (!meta?.migratedFromArchive) throw new Error("Целевата база не е от пренос (SystemMeta.migratedFromArchive липсва).");
  if (meta.migratedFromArchive !== id) throw new Error("Целевата база е пренесена от друг архив.");
  const importedAt = meta.migratedAt!;
  const ctx = { targetMode: meta.mode, archiveId: id, importedAt };
  const tables: TableCheck[] = [];
  for (const m of models()) {
    if (NOT_MIGRATED[m.name]) continue;
    const tab = a.tables[m.name]!;
    const want = tab.rows.map((r) => {
      const o = transformRow(m.name, tab.fields, r, ctx);
      return m.fields.map((f) => canonical(f.type, o[f.name]));
    });
    const got = await readTable(db, m);
    let extra = 0;
    if (m.name === "AuditLog") {
      // Импортът добавя един одитен запис "migration.import" — сравняват се останалите.
      const ai = m.fields.findIndex((f) => f.name === "action");
      const before = got.length;
      const filtered = got.filter((r) => r[ai] !== "migration.import" || want.some((w) => w[0] === r[0]));
      extra = before - filtered.length;
      got.splice(0, got.length, ...filtered);
    }
    const valuesMatch = got.length === want.length && tableDigest(got) === tableDigest(want);
    tables.push({ name: m.name, archive: tab.count, target: got.length + extra, valuesMatch, ...(extra ? { note: `+${extra} запис за преноса` } : {}) });
  }
  // Осиротели връзки — със SQL в целевата база.
  const orphanChecks: { relation: string; orphans: number }[] = [];
  for (const m of models()) {
    for (const r of m.relations) {
      if (r.fields.length !== 1) continue;
      const q = `SELECT COUNT(*)::int AS n FROM "${m.name}" c LEFT JOIN "${r.target}" p ON p."${r.targetFields[0]}" = c."${r.fields[0]}" WHERE c."${r.fields[0]}" IS NOT NULL AND p."${r.targetFields[0]}" IS NULL`;
      const [row] = (await db.$queryRawUnsafe(q)) as { n: number }[];
      orphanChecks.push({ relation: `${m.name}.${r.fields[0]} → ${r.target}`, orphans: Number(row?.n ?? 0) });
    }
  }
  const [seq] = (await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM information_schema.sequences WHERE sequence_schema = current_schema()`)) as { n: number }[];
  const ok = tables.every((t) => t.valuesMatch) && orphanChecks.every((o) => o.orphans === 0);
  return { ok, tables, orphanChecks, sequences: Number(seq?.n ?? 0) };
}
