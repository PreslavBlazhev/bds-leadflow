import { createHash } from "node:crypto";
import { audit, tx, type Ctx, type Tx } from "@/lib/db";
import { excelSerialToIsoDate, extractHyperlinkUrl, readXlsx, type XlsxBook } from "@/lib/xlsx";
import { zonedToUtc } from "@/lib/time";
import { CONTACT_ACTIVITY_TYPES } from "./constants";
import { identifiersFor, normalizePhone, safeHttpUrl } from "./identity";
import { ingestCandidate } from "./ingest";
import { getSettings, saveSettings } from "./settings";

/**
 * Импорт на реални бизнеси от Excel проучване (лист „Основен списък“).
 * - Нищо от файла не се изпълнява: връзките се извличат само от литералите в HYPERLINK/IFERROR/_xlfn._LONGTEXT.
 * - Дедупликация по текущите правила: телефон (основен и допълнителен), Google place ID от линка, име + адрес.
 * - Съвпаднал запис НЕ се нулира: попълват се само празни полета; история/DNC/списъци имат предимство.
 * - Историята преди импорта е поле (priorContact), не измислено обаждане: без дата, без резултат.
 * - Повторен импорт: 0 нови записа и 0 нови исторически отметки.
 */

export const MAIN_SHEET = "Основен списък";

export const EXPECTED_HEADERS = [
  "Пореден номер",
  "Име на бизнеса",
  "Основна категория",
  "Подкатегория",
  "Квартал/район",
  "Пълен адрес",
  "Телефон",
  "Допълнителен телефон",
  "Google Maps линк",
  "Оценка в Google",
  "Брой отзиви",
  "Работно време",
  "Статус на уебсайта",
  "Facebook",
  "Instagram",
  "Друг профил или платформа",
  "Последен скорошен отзив",
  "Дата на проверката",
  "Степен на увереност",
  "Бележки",
  "Приоритет за обаждане",
] as const;

/** Основна категория във файла → категория в приложението. Оригиналът се пази в sourceCategory. */
export const CATEGORY_MAP: Record<string, string> = {
  "Автоуслуги": "auto",
  "Красота и грижа": "beauty",
  "Красота": "beauty",
  "Храни и заведения": "restaurant",
  "Хранене и напитки": "restaurant",
  "Дом и строителство": "home",
  "Ремонт и услуги": "repair",
  "Магазини": "shops",
  "Грижа за животни": "pets",
  "Настаняване и туризъм": "lodging",
  "Професионални услуги": "professional",
  "Спорт и движение": "sport",
  "Здраве и частни кабинети": "health",
  "Обучение и детски услуги": "education",
  "Транспорт и услуги": "transport",
  "Транспортни услуги": "transport",
};

/** Всички три статуса във файла означават „не е открит собствен сайт“ при проучването — наблюдение, не категорично „няма сайт“. */
const NO_OWN_SITE = new Set(["Няма открит собствен сайт", "Само Facebook/Instagram", "Само профил в платформа"]);

export interface XlsxRow {
  seq: number;
  physicalRow: number;
  name: string;
  sourceCategory: string;
  category: string | null;
  subcategory: string | null;
  district: string | null;
  address: string | null;
  phone: string | null;
  phone2: string | null;
  mapsUrl: string | null;
  placeId: string | null;
  rating: number | null;
  reviewCount: number | null;
  openingHours: string | null;
  websiteObservation: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  otherProfileUrl: string | null;
  recentReviewNote: string | null;
  checkedOn: string | null;
  confidenceLabel: string | null;
  notes: string | null;
  callPriority: "A" | "B" | null;
}

export interface ParsedFile {
  fileName: string;
  contentHash: string;
  sheetNames: string[];
  /** Брой записи (ред с „Пореден номер“ и име) във всеки лист. */
  sheetCounts: Record<string, number>;
  rows: XlsxRow[];
  issues: { seq: number | null; physicalRow: number; message: string }[];
  linkStats: { formulas: number; longText: number; extracted: number };
}

const txt = (v: string | null | undefined) => {
  const s = (v ?? "").replace(/\r\n?/g, "\n").trim();
  return s ? s : null;
};

/** Google place ID от линка (`!19sChIJ…`) — идентификатор на източника, може да се пази. */
export function placeIdFromMapsUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /!19s(ChIJ[A-Za-z0-9_-]+)/.exec(url);
  return m ? m[1]! : null;
}

function countRecords(book: XlsxBook, name: string): number {
  const s = book.sheet(name);
  const hdr = s.rows.get(1);
  if (!hdr) return 0;
  let n = 0;
  for (const [r, cells] of s.rows) {
    if (r === 1) continue;
    if (/^\d+$/.test(cells.get("A")?.value ?? "") && txt(cells.get("B")?.value)) n++;
  }
  return n;
}

export function parseBusinessFile(buf: Buffer, fileName: string): ParsedFile {
  const book = readXlsx(buf);
  const issues: ParsedFile["issues"] = [];
  const sheetCounts: Record<string, number> = {};
  for (const n of book.sheetNames) sheetCounts[n] = n === "Покритие и статистика" ? book.sheet(n).maxRow - 1 : countRecords(book, n);
  if (!book.sheetNames.includes(MAIN_SHEET)) throw new Error(`Липсва лист „${MAIN_SHEET}“.`);
  const sheet = book.sheet(MAIN_SHEET);
  const hdr = sheet.rows.get(1);
  const cols = "ABCDEFGHIJKLMNOPQRSTU".split("");
  const got = cols.map((c) => txt(hdr?.get(c)?.value));
  const bad = EXPECTED_HEADERS.map((h, i) => (got[i] === h ? null : `${cols[i]}: очаквано „${h}“, има „${got[i] ?? ""}“`)).filter(Boolean);
  if (bad.length) throw new Error(`Неочаквани колони в „${MAIN_SHEET}“: ${bad.join("; ")}`);

  const linkStats = { formulas: 0, longText: 0, extracted: 0 };
  const rows: XlsxRow[] = [];
  const seen = new Set<number>();
  for (let r = 2; r <= sheet.maxRow; r++) {
    const cells = sheet.rows.get(r);
    if (!cells) continue;
    const g = (c: string) => txt(cells.get(c)?.value);
    if (![...cells.values()].some((c) => txt(c.value))) continue; // празен ред
    const seqRaw = g("A");
    if (!seqRaw || !/^\d+$/.test(seqRaw)) {
      issues.push({ seq: null, physicalRow: r, message: `Ред без валиден „Пореден номер“ („${seqRaw ?? ""}“) — пропуснат.` });
      continue;
    }
    const seq = Number(seqRaw);
    if (seen.has(seq)) {
      issues.push({ seq, physicalRow: r, message: `Повторен „Пореден номер“ ${seq} — пропуснат.` });
      continue;
    }
    seen.add(seq);
    const name = g("B");
    if (!name) {
      issues.push({ seq, physicalRow: r, message: "Липсва име — пропуснат." });
      continue;
    }
    const link = (c: string): string | null => {
      const cell = cells.get(c);
      if (!cell) return null;
      if (cell.formula) {
        linkStats.formulas++;
        if (/_LONGTEXT/i.test(cell.formula)) linkStats.longText++;
        try {
          const u = safeHttpUrl(extractHyperlinkUrl(cell.formula));
          if (u) linkStats.extracted++;
          else issues.push({ seq, physicalRow: r, message: `Колона ${c}: формулата не съдържа http(s) връзка.` });
          return u;
        } catch (e) {
          issues.push({ seq, physicalRow: r, message: `Колона ${c}: формулата не е разчетена (${(e as Error).message}).` });
          return null;
        }
      }
      const v = txt(cell.value);
      if (!v) return null;
      const u = safeHttpUrl(v);
      if (!u || /^(Google Maps|Facebook|Instagram|Профил)$/i.test(v)) {
        issues.push({ seq, physicalRow: r, message: `Колона ${c}: само текст „${v}“ без адрес.` });
        return null;
      }
      return u;
    };
    const sourceCategory = g("C") ?? "";
    const category = CATEGORY_MAP[sourceCategory] ?? null;
    if (!category) issues.push({ seq, physicalRow: r, message: `Непозната категория „${sourceCategory}“ — записът ще е извън списъците.` });
    const ratingRaw = g("J");
    const rating = ratingRaw && /^\d+(\.\d+)?$/.test(ratingRaw) ? Math.round(Number(ratingRaw) * 10) / 10 : null;
    const rcRaw = g("K");
    const reviewCount = rcRaw && /^\d+$/.test(rcRaw) ? Number(rcRaw) : null;
    const dRaw = g("R");
    let checkedOn: string | null = null;
    if (dRaw && /^\d+(\.\d+)?$/.test(dRaw)) checkedOn = excelSerialToIsoDate(Number(dRaw));
    else if (dRaw && /^\d{4}-\d{2}-\d{2}$/.test(dRaw)) checkedOn = dRaw;
    else issues.push({ seq, physicalRow: r, message: `Липсваща/неразчетена дата на проверката („${dRaw ?? ""}“).` });
    const pr = g("U");
    const callPriority = pr?.startsWith("A") ? "A" : pr?.startsWith("B") ? "B" : null;
    const mapsUrl = link("I");
    const phone = g("G");
    const ph = normalizePhone(phone);
    if (!ph?.normalized) issues.push({ seq, physicalRow: r, message: `Телефонът „${phone ?? ""}“ не е валиден — записът ще е за проверка.` });
    const phone2 = g("H");
    if (phone2 && !normalizePhone(phone2)?.normalized) issues.push({ seq, physicalRow: r, message: `Допълнителният телефон „${phone2}“ не е валиден.` });
    const placeId = placeIdFromMapsUrl(mapsUrl);
    if (mapsUrl && !placeId) issues.push({ seq, physicalRow: r, message: "Google Maps линкът няма place ID — дедупликация само по телефон и име/адрес." });
    rows.push({
      seq,
      physicalRow: r,
      name,
      sourceCategory,
      category,
      subcategory: g("D"),
      district: g("E"),
      address: g("F"),
      phone,
      phone2,
      mapsUrl,
      placeId,
      rating,
      reviewCount,
      openingHours: g("L"),
      websiteObservation: g("M"),
      facebookUrl: link("N"),
      instagramUrl: link("O"),
      otherProfileUrl: link("P"),
      recentReviewNote: g("Q"),
      checkedOn,
      confidenceLabel: g("S"),
      notes: g("T"),
      callPriority,
    });
  }
  return { fileName, contentHash: createHash("sha256").update(buf).digest("hex"), sheetNames: book.sheetNames, sheetCounts, rows, issues, linkStats };
}

/** "1-20,51-65" → множество от номера. */
export function parseRanges(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`Невалиден диапазон „${part}“`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (b < a) throw new Error(`Обърнат диапазон „${part}“`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

export interface ImportOptions {
  /** „Пореден номер“ на бизнесите, на които собственикът потвърждава, че е звънял преди импорта. */
  calledBefore: Set<number>;
  /** Собственикът потвърждава, че на останалите от листа не е звънял. */
  confirmOthersNotCalled: boolean;
  /** Превключва новите дневни списъци към реалните записи (без да трие демо историята). */
  activateRealSource?: boolean;
  dryRun?: boolean;
}

export interface RowResult {
  seq: number;
  name: string;
  action: "created" | "matched" | "review" | "skipped";
  history: "CALLED_BEFORE_IMPORT" | "NOT_CALLED";
  historyWritten: boolean;
  /** Ако съществуващ запис има по-силна история/DNC/списък — какво е запазено. */
  kept?: string;
  message?: string;
  businessId?: string;
  ref?: string;
}

export interface ImportReport {
  fileName: string;
  sheet: string;
  contentHash: string;
  dryRun: boolean;
  importBatchId: string | null;
  read: number;
  created: number;
  matched: number;
  review: number;
  skipped: number;
  calledMarked: number;
  notCalledMarked: number;
  historyWritten: number;
  rows: RowResult[];
  issues: ParsedFile["issues"];
}

class DryRunRollback extends Error {
  constructor(public report: ImportReport) {
    super("dry-run rollback");
  }
}

export const PRIOR_CALLED_NOTE = "Собственикът потвърждава предишен опит за обаждане преди импорта. Дата и резултат: неизвестни.";
export const PRIOR_NOT_CALLED_NOTE = "Собственикът потвърждава, че към датата на импорта не е звънял на този бизнес.";

async function fillEmpty(t: Tx, id: string, data: Record<string, unknown>) {
  const cur = (await t.business.findUniqueOrThrow({ where: { id } })) as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined && (cur[k] === null || cur[k] === undefined)) patch[k] = v;
  if (Object.keys(patch).length) await t.business.update({ where: { id }, data: patch });
}

export async function importBusinessFile(ctx: Ctx, parsed: ParsedFile, opts: ImportOptions): Promise<ImportReport> {
  const now = ctx.clock.now();
  const missing = [...opts.calledBefore].filter((n) => !parsed.rows.some((r) => r.seq === n));
  if (missing.length) throw new Error(`Номера от историята липсват във файла: ${missing.join(", ")}`);
  try {
    return await tx(ctx.db, async (t) => {
      const batch = await t.importBatch.create({
        data: { filename: `${parsed.fileName} › ${MAIN_SHEET}`, contentHash: parsed.contentHash, status: opts.dryRun ? "PREVIEW" : "COMMITTED", usageConfirmed: true, confirmedUncontacted: opts.confirmOthersNotCalled },
      });
      const rep: ImportReport = {
        fileName: parsed.fileName,
        sheet: MAIN_SHEET,
        contentHash: parsed.contentHash,
        dryRun: !!opts.dryRun,
        importBatchId: opts.dryRun ? null : batch.id,
        read: parsed.rows.length,
        created: 0,
        matched: 0,
        review: 0,
        skipped: 0,
        calledMarked: 0,
        notCalledMarked: 0,
        historyWritten: 0,
        rows: [],
        issues: parsed.issues,
      };
      for (const r of parsed.rows) {
        const called = opts.calledBefore.has(r.seq);
        const history = called ? "CALLED_BEFORE_IMPORT" : "NOT_CALLED";
        const res: RowResult = { seq: r.seq, name: r.name, action: "skipped", history, historyWritten: false };
        rep.rows.push(res);
        if (!called && !opts.confirmOthersNotCalled) {
          res.message = "Няма потвърдена история — не е импортиран.";
          rep.skipped++;
          continue;
        }
        const verifiedAt = r.checkedOn ? zonedToUtc(r.checkedOn, "00:00") : null;
        const ing = await ingestCandidate(
          t,
          {
            name: r.name,
            city: "Варна",
            address: r.address,
            category: r.category ?? "unmapped",
            phone: r.phone,
            website: null, // собствен сайт не е открит; профилите са в отделни полета
            socialUrl: r.facebookUrl ?? r.instagramUrl,
            mapsUrl: r.mapsUrl,
            placeId: r.placeId,
            rating: r.rating,
            reviewCount: r.reviewCount,
            ratingSource: r.rating !== null ? `Google Maps — по Excel проучването (${r.checkedOn ?? "без дата"})` : null,
            websiteStatus: r.websiteObservation && NO_OWN_SITE.has(r.websiteObservation) ? "NOT_FOUND_AFTER_CHECK" : "UNCHECKED",
            phoneVerified: false, // публикуван телефон ≠ проверен с обаждане
            source: "XLSX",
            sourceRef: `${parsed.fileName} › ${MAIN_SHEET} › №${r.seq}`,
            sourceUrl: r.mapsUrl,
            sourceUsageConfirmed: true, // собственикът е възложил импорта на собственото си проучване
            fetchedAt: now,
            verifiedAt,
            contactHistoryState: called ? "HAS_HISTORY" : "NONE_CONFIRMED",
            pipelineStage: "NEW",
            notes: r.notes,
          },
          now,
          { nameMatch: "address" },
        );
        res.businessId = ing.businessId;
        const extra = {
          sourceCategory: r.sourceCategory || null,
          subcategory: r.subcategory,
          district: r.district,
          address: r.address,
          phone2Raw: r.phone2,
          phone2Normalized: normalizePhone(r.phone2)?.normalized ?? null,
          openingHours: r.openingHours,
          websiteObservation: r.websiteObservation,
          facebookUrl: r.facebookUrl,
          instagramUrl: r.instagramUrl,
          otherProfileUrl: r.otherProfileUrl,
          recentReviewNote: r.recentReviewNote,
          sourceCheckedOn: r.checkedOn,
          confidenceLabel: r.confidenceLabel,
          callPriority: r.callPriority,
          sourceName: parsed.fileName,
          sourceSheet: MAIN_SHEET,
          sourceRowNo: r.seq,
          importedAt: now,
          mapsUrl: r.mapsUrl,
        };

        if (ing.kind === "created") {
          await t.business.update({ where: { id: ing.businessId }, data: extra });
          if (ing.review) {
            rep.review++;
            res.action = "review";
            res.message = ing.reason;
            await t.importRowIssue.create({ data: { importBatchId: batch.id, rowNumber: r.seq, kind: "CONFLICT", message: ing.reason ?? "Възможен дубликат" } });
          } else {
            rep.created++;
            res.action = "created";
          }
          // Наблюдението за сайта — с доказателство (източник и дата), без да става категорично „няма сайт“.
          if (r.websiteObservation && NO_OWN_SITE.has(r.websiteObservation) && verifiedAt) {
            await t.websiteAudit.create({
              data: {
                businessId: ing.businessId,
                checkedAt: verifiedAt,
                url: null,
                result: "NOT_FOUND",
                issues: "[]",
                evidence: `Наблюдение от проучването „${parsed.fileName}“ (${r.checkedOn}): „${r.websiteObservation}“. Не е проверка на приложението.`,
              },
            });
          }
          await t.sourceEvidence.create({
            data: {
              businessId: ing.businessId,
              provider: "XLSX",
              field: "record",
              sourceUrl: r.mapsUrl,
              fetchedAt: now,
              verifiedAt,
              storageAllowed: true,
              derivedUseAllowed: true,
              note: `${parsed.fileName} › ${MAIN_SHEET} › №${r.seq}; увереност: ${r.confidenceLabel ?? "—"}; импортиран ${now.toISOString().slice(0, 10)} (импортът не е нова проверка).`,
            },
          });
        } else {
          rep.matched++;
          res.action = "matched";
          res.message = ing.reason;
          await fillEmpty(t, ing.businessId, extra);
        }

        // Допълнителен телефон: идентификатор за бъдеща дедупликация; при съвпадение с друг запис → проверка.
        const p2 = normalizePhone(r.phone2);
        if (p2?.normalized) {
          const other = await t.businessIdentifier.findFirst({ where: { type: "PHONE", value: p2.normalized, businessId: { not: ing.businessId } }, include: { business: { select: { ref: true } } } });
          await t.businessIdentifier.upsert({
            where: { businessId_type_value: { businessId: ing.businessId, type: "PHONE", value: p2.normalized } },
            create: { businessId: ing.businessId, type: "PHONE", value: p2.normalized },
            update: {},
          });
          if (other && ing.kind === "created") {
            await t.business.update({ where: { id: ing.businessId }, data: { reviewStatus: "DUPLICATE_REVIEW", reviewReason: `Допълнителният телефон съвпада с ${other.business.ref}` } });
            await t.duplicateCandidate.upsert({
              where: { businessAId_businessBId_matchType: { businessAId: ing.businessId, businessBId: other.businessId, matchType: "PHONE" } },
              create: { businessAId: ing.businessId, businessBId: other.businessId, matchType: "PHONE", matchValue: p2.normalized },
              update: {},
            });
            if (res.action === "created") {
              rep.created--;
              rep.review++;
              res.action = "review";
              res.message = `Допълнителният телефон съвпада с ${other.business.ref}`;
            }
          }
        }

        // История преди импорта — веднъж; съществуваща CRM история/DNC/списък има предимство.
        const b = await t.business.findUniqueOrThrow({
          where: { id: ing.businessId },
          include: {
            batchItem: { select: { id: true } },
            suppressions: { where: { liftedAt: null }, select: { type: true } },
            _count: { select: { activities: { where: { type: { in: CONTACT_ACTIVITY_TYPES } } } } },
          },
        });
        res.ref = b.ref;
        const kept: string[] = [];
        if (b.suppressions.some((s) => s.type === "DNC")) kept.push("DNC");
        if (b.batchItem || b.firstIssuedAt) kept.push("вече издаден в списък");
        if (b._count.activities > 0) kept.push("записани контакти");
        if (b.pipelineStage !== "NEW") kept.push(`етап ${b.pipelineStage}`);
        if (b.priorContact === "CALLED_BEFORE_IMPORT" && !called) kept.push("вече отбелязан като прозвънен");
        if (kept.length) res.kept = kept.join(", ");
        if (!b.priorContact) {
          await t.business.update({
            where: { id: b.id },
            data: {
              priorContact: history,
              priorContactSource: "OWNER_CONFIRMATION",
              priorContactNote: called ? PRIOR_CALLED_NOTE : PRIOR_NOT_CALLED_NOTE,
              priorContactRecordedAt: now,
            },
          });
          res.historyWritten = true;
          rep.historyWritten++;
        }
        if (called) {
          rep.calledMarked++;
          // Само по-строго: прозвъненият никога не е „нов“.
          if (b.contactHistoryState !== "HAS_HISTORY") await t.business.update({ where: { id: b.id }, data: { contactHistoryState: "HAS_HISTORY" } });
        } else {
          rep.notCalledMarked++;
          // „Не е звъняно“ отваря записа само ако няма нищо по-силно (история, DNC, списък, етап).
          if (b.contactHistoryState === "UNKNOWN" && kept.length === 0) await t.business.update({ where: { id: b.id }, data: { contactHistoryState: "NONE_CONFIRMED" } });
        }
      }
      if (opts.activateRealSource) {
        const s = await getSettings(t);
        if (s.leadSource !== "REAL") await saveSettings(t, { ...s, leadSource: "REAL" });
      }
      const counts = { read: rep.read, created: rep.created, matched: rep.matched, review: rep.review, skipped: rep.skipped, historyWritten: rep.historyWritten };
      await t.importBatch.update({ where: { id: batch.id }, data: { counts: JSON.stringify(counts) } });
      await audit(t, ctx.actor, opts.dryRun ? "import.xlsx.preview" : "import.xlsx.commit", "ImportBatch", batch.id, {
        file: parsed.fileName,
        sheet: MAIN_SHEET,
        hash: parsed.contentHash,
        counts,
        calledBefore: [...opts.calledBefore].sort((a, b) => a - b),
        historySource: "OWNER_CONFIRMATION",
        activateRealSource: !!opts.activateRealSource,
      });
      if (opts.dryRun) throw new DryRunRollback(rep);
      return rep;
    }, 1, 180_000); // един опит: при грешка всичко се връща (атомарно), без частичен импорт
  } catch (e) {
    if (e instanceof DryRunRollback) return e.report;
    throw e;
  }
}

/** Идентификатори на ред от файла (за проверки/отчет). */
export function rowIdentifiers(r: XlsxRow) {
  return identifiersFor({ name: r.name, city: "Варна", phone: r.phone, placeId: r.placeId });
}
