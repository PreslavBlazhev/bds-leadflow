import type { Business, BusinessIdentifier, WebsiteAudit } from "@prisma/client";
import type { DbLike, Mode } from "@/lib/db";
import { CONTACT_ACTIVITY_TYPES } from "./constants";
import { scoreBusiness, type ScoreResult } from "./scoring";
import { allowedCities, dataMode, type Settings } from "./settings";

/**
 * Единствената дефиниция за "допустим за НОВ дневен списък". Използва се от ръчното генериране,
 * scheduler-а, dry-run, detail панела и тестовете. Hard exclusions — не са точки в score.
 */

export type CandidateRow = Business & {
  identifiers: BusinessIdentifier[];
  audits: WebsiteAudit[];
  batchItem: { id: string; issuedAt: Date } | null;
  _count: { activities: number };
};

export interface EligibilityCtx {
  mode: Mode;
  settings: Settings;
  now: Date;
  /** identifier key → причина (принадлежи на издаден/контактуван/DNC/неясен запис) */
  taintedIdentifiers: Map<string, string>;
  suppressedIdentifiers: Map<string, string>;
  suppressedBusinesses: Map<string, string>;
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

const idKey = (type: string, value: string) => `${type}:${value}`;
/** NAME_CITY е слаб сигнал — не блокира сам, само води до review при въвеждане. */
const STRONG_TYPES = new Set(["PHONE", "DEMO_PHONE", "DOMAIN", "EIK", "PLACE_ID"]);

export async function buildEligibilityCtx(db: DbLike, mode: Mode, settings: Settings, now: Date): Promise<EligibilityCtx> {
  const suppressions = await db.suppression.findMany({ where: { liftedAt: null } });
  const suppressedIdentifiers = new Map<string, string>();
  const suppressedBusinesses = new Map<string, string>();
  for (const s of suppressions) {
    const label = s.type === "DNC" ? "DNC — не се свързвай" : "Блокиран (невалиден) телефон";
    if (s.businessId) suppressedBusinesses.set(s.businessId, label);
    if (s.identifierType && s.identifierValue) suppressedIdentifiers.set(idKey(s.identifierType, s.identifierValue), label);
  }

  // Идентификатори на записи, които вече НЕ са "чисти": издадени, контактувани, с история, неясни, затворени, DNC.
  const tainted = await db.businessIdentifier.findMany({
    where: {
      type: { in: [...STRONG_TYPES] },
      business: {
        OR: [
          { firstIssuedAt: { not: null } },
          { contactHistoryState: { not: "NONE_CONFIRMED" } },
          { pipelineStage: { not: "NEW" } },
          { activities: { some: { type: { in: CONTACT_ACTIVITY_TYPES } } } },
          { suppressions: { some: { liftedAt: null } } },
        ],
      },
    },
    select: { type: true, value: true, businessId: true, business: { select: { ref: true } } },
  });
  const taintedIdentifiers = new Map<string, string>();
  for (const t of tainted) taintedIdentifiers.set(idKey(t.type, t.value), `${t.businessId}|${t.business.ref}`);

  // Реален източник в demo база → правилата за real (demo записите и синтетичните телефони са изключени).
  return { mode: dataMode(mode, settings), settings, now, taintedIdentifiers, suppressedIdentifiers, suppressedBusinesses };
}

export function evaluateEligibility(b: CandidateRow, ctx: EligibilityCtx): Eligibility {
  const r: string[] = [];
  const s = ctx.settings;
  if (b.mergedIntoId) r.push("Слят в друг запис (не е каноничен).");
  if (b.batchItem || b.firstIssuedAt) r.push("Вече е издаван като нов — показан вчера/по-рано не е нов днес.");
  if (b.contactHistoryState === "HAS_HISTORY") r.push("Има история на контакт.");
  if (b.contactHistoryState === "UNKNOWN") r.push("Неизвестна история на контакт — нужна е потвърдена история.");
  if (b._count.activities > 0) r.push("Има записан контакт/опит.");
  const sup = ctx.suppressedBusinesses.get(b.id);
  if (sup) r.push(sup);
  if (b.status !== "ACTIVE") r.push(b.status === "CLOSED" ? "Бизнесът е затворен." : "Архивиран.");
  if (b.pipelineStage !== "NEW") r.push(`Етап ${b.pipelineStage} — не е нов.`);
  if (b.reviewStatus === "DUPLICATE_REVIEW") r.push(`В проверка за дубликат${b.reviewReason ? `: ${b.reviewReason}` : ""}.`);
  if (b.reviewStatus === "NEEDS_CHECK") r.push(`Маркиран за проверка${b.reviewReason ? `: ${b.reviewReason}` : ""}.`);

  if (!b.phoneNormalized) r.push("Няма проверен служебен телефон.");
  else if (b.phoneKind === "INVALID") r.push("Телефонът е с невалиден формат.");
  else if (ctx.mode === "real" && b.phoneKind === "DEMO_SYNTHETIC") r.push("Синтетичен demo телефон в real режим.");
  if (ctx.mode === "real" && b.isDemo) r.push("Demo запис — реалните списъци съдържат само реални записи.");

  if (!b.sourceUsageConfirmed) r.push("Източникът няма потвърдено право за използване/съхранение.");
  if (b.source === "GOOGLE_PLACES" || b.source === "B2B") r.push(`Източник ${b.source} е BLOCKED (няма потвърдени условия).`);

  if (!allowedCities(s).includes(b.city)) r.push(`Град „${b.city}“ не е сред разрешените.`);
  const cat = s.categories.find((c) => c.key === b.category);
  if (!cat || !cat.enabled) r.push("Категорията не е разрешена в настройките.");

  const freshMs = s.reserveFreshnessDays * 86_400_000;
  if (!b.verifiedAt) r.push("Данните не са проверени (няма verified_at).");
  else if (ctx.now.getTime() - b.verifiedAt.getTime() > freshMs) r.push(`Проверката е по-стара от ${s.reserveFreshnessDays} дни.`);

  for (const ident of b.identifiers) {
    if (!STRONG_TYPES.has(ident.type) || !ident.active) continue;
    const k = idKey(ident.type, ident.value);
    const supI = ctx.suppressedIdentifiers.get(k);
    if (supI) r.push(`Идентификатор под потискане (${ident.type}): ${supI}.`);
    const t = ctx.taintedIdentifiers.get(k);
    if (t && !t.startsWith(`${b.id}|`)) {
      r.push(`Споделен ${ident.type === "DOMAIN" ? "домейн" : "телефон/идентификатор"} с вече издаден/контактуван запис ${t.split("|")[1]}.`);
    }
  }
  return { eligible: r.length === 0, reasons: [...new Set(r)] };
}

export function scoreFactsOf(b: CandidateRow) {
  const audit = [...b.audits].sort((a, c) => c.checkedAt.getTime() - a.checkedAt.getTime())[0];
  const issues = audit ? (JSON.parse(audit.issues) as string[]) : [];
  return {
    city: b.city,
    websiteStatus: b.websiteStatus,
    websiteEvidence: !!audit,
    auditIssues: issues,
    poorMobile: audit?.poorMobile ?? null,
    strongModern: audit?.strongModern ?? null,
    rating: b.rating,
    reviewCount: b.reviewCount,
    ratingUsable: b.rating !== null && !!b.ratingSource,
    socialActive: b.socialActive,
    phoneVerified: b.phoneVerified,
    isChain: b.isChain,
  };
}

export const candidateInclude = {
  identifiers: true,
  audits: true,
  batchItem: { select: { id: true, issuedAt: true } },
  _count: { select: { activities: { where: { type: { in: CONTACT_ACTIVITY_TYPES } } } } },
} as const;

export interface ScoredCandidate {
  b: CandidateRow;
  score: ScoreResult;
}

/** Всички допустими кандидати, сортирани: score ↓, verified_at ↓ (по-свежи), id ↑ (стабилно). */
export async function eligiblePool(db: DbLike, ctx: EligibilityCtx): Promise<ScoredCandidate[]> {
  const rows = (await db.business.findMany({
    where: {
      mergedIntoId: null,
      firstIssuedAt: null,
      batchItem: null,
      status: "ACTIVE",
      pipelineStage: "NEW",
      contactHistoryState: "NONE_CONFIRMED",
      reviewStatus: "NONE",
      city: { in: allowedCities(ctx.settings) },
    },
    include: candidateInclude,
  })) as CandidateRow[];
  const out: ScoredCandidate[] = [];
  for (const b of rows) {
    if (!evaluateEligibility(b, ctx).eligible) continue;
    out.push({ b, score: scoreBusiness(scoreFactsOf(b), ctx.settings) });
  }
  out.sort(
    (x, y) =>
      y.score.score - x.score.score ||
      (y.b.verifiedAt?.getTime() ?? 0) - (x.b.verifiedAt?.getTime() ?? 0) ||
      (x.b.id < y.b.id ? -1 : x.b.id > y.b.id ? 1 : 0),
  );
  return prioritize(out);
}

const TIER: Record<string, number> = { A: 0, B: 1 };

/**
 * Записи с приоритет от източника (A/B): първо A, после B, а вътре — редуване по категории
 * (във всяка категория се запазва редът по score), за разумно разнообразие в един списък.
 * Записи без приоритет (напр. demo) остават след тях в реда по score — поведението им не се променя.
 */
export function prioritize(pool: ScoredCandidate[]): ScoredCandidate[] {
  const tiers = new Map<number, ScoredCandidate[]>();
  for (const c of pool) {
    const t = TIER[c.b.callPriority ?? ""] ?? 9;
    tiers.set(t, [...(tiers.get(t) ?? []), c]);
  }
  const out: ScoredCandidate[] = [];
  for (const t of [...tiers.keys()].sort((a, b) => a - b)) {
    const list = tiers.get(t)!;
    if (t === 9) {
      out.push(...list);
      continue;
    }
    const byCat = new Map<string, ScoredCandidate[]>();
    for (const c of list) byCat.set(c.b.category, [...(byCat.get(c.b.category) ?? []), c]);
    const queues = [...byCat.values()];
    for (let i = 0; out.length < pool.length && queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]!);
  }
  return out;
}
