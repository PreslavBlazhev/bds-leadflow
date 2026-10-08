import { createHash } from "node:crypto";
import Papa from "papaparse";
import { z } from "zod";
import { audit, tx, type Ctx } from "@/lib/db";
import { CATEGORIES, STAGES } from "./constants";
import { DomainError } from "./errors";
import { identifiersFor, normalizePhone, safeHttpUrl } from "./identity";
import { ingestCandidate } from "./ingest";

/**
 * CSV импорт с mapping, preview и дедупликация. Импортиран запис по подразбиране е с НЕИЗВЕСТНА история
 * (извън новите), освен при изрично потвърждение за целия импорт (с audit).
 * Повторен импорт на същия файл не създава нови бизнеси/дейности и не нулира DNC/история.
 */

export const MAX_IMPORT_BYTES = 2_000_000;
export const MAX_IMPORT_ROWS = 5000;

export const IMPORT_FIELDS = [
  "Business Name",
  "Business Type",
  "City",
  "Source",
  "Phone",
  "Email",
  "Social Link",
  "Has Website",
  "Problem",
  "Service Offer",
  "Potential Value",
  "Stage",
  "Priority",
  "Last Contact",
  "Next Contact",
  "Next Action",
  "Notes",
  "contacted_before",
  "first_issued_at",
  "Website",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, string>>;

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new DomainError("VALIDATION", "Файлът е по-голям от 2 MB.");
  const clean = text.replace(/^﻿/, "");
  const res = Papa.parse<Record<string, string>>(clean, { header: true, skipEmptyLines: "greedy", dynamicTyping: false, delimitersToGuess: [",", ";", "\t"] });
  if (res.data.length > MAX_IMPORT_ROWS) throw new DomainError("VALIDATION", `Максимум ${MAX_IMPORT_ROWS} реда.`);
  const headers = (res.meta.fields ?? []).map((h) => h.trim());
  return { headers, rows: res.data };
}

/** Автоматичен mapping по име на колона (без значение главни/малки букви и интервали). */
export function autoMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  for (const f of IMPORT_FIELDS) {
    const h = headers.find((x) => norm(x) === norm(f));
    if (h) m[f] = h;
  }
  return m;
}

const CATEGORY_GUESS: [RegExp, string][] = [
  [/пиц|ресторант|механа|бистро|кафе|pizza|restaurant/i, "restaurant"],
  [/авто|гуми|сервиз|auto|car/i, "auto"],
  [/салон|красот|маникюр|фризьор|beauty|nail|hair/i, "beauty"],
  [/ремонт|строит|вик|дограма|build|repair|home/i, "home"],
];

function guessCategory(v: string): string | null {
  if (CATEGORIES.some((c) => c.key === v)) return v;
  for (const [re, key] of CATEGORY_GUESS) if (re.test(v)) return key;
  return null;
}

const YES = /^(yes|да|true|1|y)$/i;
const NO = /^(no|не|false|0|n)$/i;

export function parseEuroCents(v: string): number | null {
  const s = v.replace(/[€\s]|EUR|евро/gi, "").replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Невалидна сума „${v}“`);
  return Math.round(Number(s) * 100);
}

function parseDateish(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T09:00:00Z`);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T09:00:00Z`);
  throw new Error(`Невалидна дата „${v}“ (dd.MM.yyyy или yyyy-MM-dd)`);
}

export interface RowPlan {
  row: number;
  action: "create" | "duplicate" | "conflict" | "skip";
  message: string;
  name: string;
  city: string;
}

interface ParsedRow {
  name: string;
  city: string;
  category: string;
  phone: string | null;
  email: string | null;
  social: string | null;
  website: string | null;
  hasWebsite: string;
  stage: string | null;
  lastContact: Date | null;
  nextContact: Date | null;
  firstIssued: Date | null;
  contactedBefore: "yes" | "no" | "unknown";
  value: number | null;
  notes: string;
  nextAction: string | null;
  service: string | null;
  source: string | null;
}

function readRow(r: Record<string, string>, m: Mapping): ParsedRow {
  const g = (f: ImportField) => (m[f] ? (r[m[f]!] ?? "").trim() : "");
  const name = g("Business Name");
  const city = g("City");
  if (!name) throw new Error("Липсва име на бизнеса");
  if (!city) throw new Error("Липсва град");
  const category = guessCategory(g("Business Type"));
  if (!category) throw new Error(`Неразпознат тип „${g("Business Type")}“`);
  const stageRaw = g("Stage").toUpperCase();
  const stage = stageRaw ? ((STAGES as readonly string[]).includes(stageRaw) ? stageRaw : null) : null;
  if (stageRaw && !stage) throw new Error(`Неразпознат етап „${g("Stage")}“`);
  const cb = g("contacted_before");
  const website = g("Website") || null;
  const social = g("Social Link") || null;
  if (website && !safeHttpUrl(website)) throw new Error("Невалиден сайт (само http/https)");
  if (social && !safeHttpUrl(social)) throw new Error("Невалидна социална връзка (само http/https)");
  const notesParts = [g("Notes"), g("Problem") ? `Проблем: ${g("Problem")}` : "", g("Priority") ? `Приоритет: ${g("Priority")}` : ""].filter(Boolean);
  return {
    name,
    city,
    category,
    phone: g("Phone") || null,
    email: g("Email") || null,
    social,
    website,
    hasWebsite: g("Has Website"),
    stage,
    lastContact: parseDateish(g("Last Contact")),
    nextContact: parseDateish(g("Next Contact")),
    firstIssued: parseDateish(g("first_issued_at")),
    contactedBefore: YES.test(cb) ? "yes" : NO.test(cb) ? "no" : "unknown",
    value: parseEuroCents(g("Potential Value")),
    notes: notesParts.join("\n"),
    nextAction: g("Next Action") || null,
    service: g("Service Offer") || null,
    source: g("Source") || null,
  };
}

/** Preview: валидиране + дедупликация срещу файла и DB. Без записи. */
export async function previewImport(ctx: Ctx, text: string, mapping?: Mapping) {
  const { headers, rows } = parseCsv(text);
  const m = mapping ?? autoMapping(headers);
  const plans: RowPlan[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 2;
    let p: ParsedRow;
    try {
      p = readRow(rows[i]!, m);
    } catch (e) {
      plans.push({ row: rowNo, action: "skip", message: (e as Error).message, name: rows[i]?.[m["Business Name"] ?? ""] ?? "", city: "" });
      continue;
    }
    const ids = identifiersFor({ name: p.name, city: p.city, phone: p.phone, website: p.website });
    const dupInFile = ids.map((x) => seen.get(`${x.type}:${x.value}`)).find((x) => x !== undefined);
    ids.forEach((x) => seen.set(`${x.type}:${x.value}`, rowNo));
    if (dupInFile) {
      plans.push({ row: rowNo, action: "duplicate", message: `Дубликат на ред ${dupInFile} в същия файл`, name: p.name, city: p.city });
      continue;
    }
    const hits = await ctx.db.businessIdentifier.findMany({ where: { OR: ids.map((x) => ({ type: x.type, value: x.value })) }, include: { business: { select: { ref: true, normalizedName: true } } } });
    if (hits.length === 0) plans.push({ row: rowNo, action: "create", message: p.contactedBefore === "yes" || p.lastContact || p.stage ? "Нов запис с история" : "Нов запис (неизвестна история)", name: p.name, city: p.city });
    else {
      const strong = hits.filter((h) => h.type !== "NAME_CITY");
      const refs = [...new Set(hits.map((h) => h.business.ref))];
      const ph = normalizePhone(p.phone);
      const sameName = strong.length > 0 && strong.every((h) => h.business.normalizedName === hits[0]!.business.normalizedName) && refs.length === 1;
      plans.push({
        row: rowNo,
        action: sameName && ph?.kind !== "INVALID" ? "duplicate" : "conflict",
        message: sameName ? `Вече съществува: ${refs.join(", ")} — няма да се създаде/нулира` : `Конфликт с ${refs.join(", ")} — ще се създаде за проверка (извън новите)`,
        name: p.name,
        city: p.city,
      });
    }
  }
  const counts = { create: 0, duplicate: 0, conflict: 0, skip: 0 };
  plans.forEach((p) => counts[p.action]++);
  return { headers, mapping: m, plans, counts, totalRows: rows.length };
}

export const commitInput = z.object({
  filename: z.string().min(1).max(200),
  text: z.string().min(1),
  mapping: z.record(z.string(), z.string()).optional(),
  usageConfirmed: z.literal(true, { error: "Потвърди правото за използване на данните." }),
  confirmNeverContacted: z.boolean().default(false),
});

export async function commitImport(ctx: Ctx, raw: z.input<typeof commitInput>) {
  const v = commitInput.parse(raw);
  const { rows, headers } = parseCsv(v.text);
  const m = (v.mapping as Mapping | undefined) ?? autoMapping(headers);
  const hash = createHash("sha256").update(v.text).digest("hex");
  const now = ctx.clock.now();
  return tx(ctx.db, async (t) => {
    const batch = await t.importBatch.create({ data: { filename: v.filename, contentHash: hash, status: "COMMITTED", usageConfirmed: true, confirmedUncontacted: v.confirmNeverContacted } });
    const counts = { created: 0, duplicate: 0, conflict: 0, skipped: 0 };
    for (let i = 0; i < rows.length; i++) {
      const rowNo = i + 2;
      let p: ParsedRow;
      try {
        p = readRow(rows[i]!, m);
      } catch (e) {
        counts.skipped++;
        await t.importRowIssue.create({ data: { importBatchId: batch.id, rowNumber: rowNo, kind: "INVALID", message: (e as Error).message } });
        continue;
      }
      const hasHistory = p.contactedBefore === "yes" || !!p.lastContact || (!!p.stage && p.stage !== "NEW");
      const state = hasHistory ? "HAS_HISTORY" : v.confirmNeverContacted ? "NONE_CONFIRMED" : "UNKNOWN";
      const res = await ingestCandidate(
        t,
        {
          name: p.name,
          city: p.city,
          category: p.category,
          phone: p.phone,
          email: p.email,
          website: p.website,
          socialUrl: p.social,
          websiteStatus: p.website ? "FOUND" : "UNCHECKED", // "Has Website: no" от стар файл не е проверка
          source: "CSV",
          sourceRef: `${v.filename}#${rowNo}${p.source ? ` (${p.source})` : ""}`,
          sourceUsageConfirmed: true,
          verifiedAt: null, // импортът не е проверка; нужна е верификация преди да влезе в новите
          contactHistoryState: state,
          firstIssuedAt: p.firstIssued,
          pipelineStage: p.stage ?? (hasHistory ? "CONTACTED" : "NEW"),
          suggestedService: p.service,
          estimatedValueCents: p.value,
          notes: p.notes || null,
        },
        now,
      );
      if (res.kind === "existing") {
        counts.duplicate++;
        await t.importRowIssue.create({ data: { importBatchId: batch.id, rowNumber: rowNo, kind: "DUPLICATE", message: res.reason } });
        continue;
      }
      if (res.review) {
        counts.conflict++;
        await t.importRowIssue.create({ data: { importBatchId: batch.id, rowNumber: rowNo, kind: "CONFLICT", message: res.reason ?? "Конфликт" } });
      } else counts.created++;
      if (p.lastContact) {
        await t.activity.create({ data: { businessId: res.businessId, type: "IMPORTED_HISTORY", note: `Импортиран последен контакт (${v.filename})`, occurredAt: p.lastContact } });
        await t.business.update({ where: { id: res.businessId }, data: { lastContactAt: p.lastContact } });
      }
      if (p.nextContact && p.nextContact > now) {
        await t.followUp.create({ data: { businessId: res.businessId, kind: "GENERAL", dueAt: p.nextContact, reason: p.nextAction ?? "Следващ контакт (импорт)" } });
      }
    }
    await t.importBatch.update({ where: { id: batch.id }, data: { counts: JSON.stringify(counts) } });
    await audit(t, ctx.actor, "import.commit", "ImportBatch", batch.id, { counts, confirmNeverContacted: v.confirmNeverContacted, filename: v.filename });
    return { importBatchId: batch.id, counts };
  });
}

/* ---------------- Export ---------------- */

/** Защита от formula injection в Excel: стойности, започващи с = + - @ TAB CR, получават водещ апостроф. */
export function csvSafe(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (s: string) => (/[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [headers.map(esc).join(","), ...rows.map((r) => r.map((c) => esc(csvSafe(c))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Експорт само на собствени CRM данни. Без отзиви, provider payloads, тайни или DISPLAY_ONLY полета. */
export async function exportLeadsCsv(ctx: Ctx): Promise<string> {
  const rows = await ctx.db.business.findMany({ where: { mergedIntoId: null }, orderBy: { ref: "asc" }, include: { suppressions: { where: { liftedAt: null } } } });
  const headers = ["Lead ID", "Business Name", "Business Type", "City", "Source", "Phone", "Email", "Social Link", "Website", "Has Website", "Stage", "Last Outcome", "Last Contact", "First Issued", "Contact History", "DNC", "Status", "Notes"];
  const data = rows.map((b) => {
    // Записи от ограничени източници: само собствените CRM полета.
    const restricted = b.source === "GOOGLE_PLACES";
    return [
      b.ref,
      b.name,
      b.category,
      b.city,
      b.source,
      restricted || b.phoneKind === "DEMO_SYNTHETIC" ? "" : b.phoneNormalized,
      restricted ? "" : b.email,
      restricted ? "" : b.socialUrl,
      restricted ? "" : b.website,
      b.websiteStatus,
      b.pipelineStage,
      b.lastOutcome,
      b.lastContactAt?.toISOString().slice(0, 10),
      b.firstIssuedAt?.toISOString().slice(0, 10),
      b.contactHistoryState,
      b.suppressions.some((s) => s.type === "DNC") ? "yes" : "no",
      b.status,
      b.notes,
    ];
  });
  await audit(ctx.db, ctx.actor, "export.leads", undefined, undefined, { rows: data.length });
  return toCsv(headers, data);
}

export const SAMPLE_CSV = toCsv(
  ["Business Name", "Business Type", "City", "Source", "Phone", "Email", "Social Link", "Website", "Has Website", "Problem", "Service Offer", "Potential Value", "Stage", "Priority", "Last Contact", "Next Contact", "Next Action", "Notes", "contacted_before", "first_issued_at"],
  [
    ["ПРИМЕР Пицария „Тест“", "Пицария", "Варна", "Ръчно проучване", "DEMO-9001", "", "", "", "no", "Няма сайт", "Сайт с меню", "700", "", "High", "", "", "", "Примерен ред", "", ""],
    ["ПРИМЕР Автосервиз 2", "Автосервиз", "Плевен", "Стар CRM", "DEMO-9002", "", "", "https://primer-2.example.invalid", "yes", "Бавен сайт", "Онлайн записване", "950,50", "CONTACTED", "", "12.09.2026", "", "", "Звънено през септември", "yes", "2026-09-10"],
  ],
);
