import type { Tx } from "@/lib/db";
import { nextRef } from "@/lib/db";
import { identifiersFor, normalizeDomain, normalizeName, normalizePhone, safeHttpUrl } from "./identity";

/**
 * Въвеждане на кандидат от provider/CSV/ръчно с консервативно identity matching.
 * - Силен идентификатор + същото нормализирано име (или EIK/Place ID) → съществуващ бизнес; НИЩО не се нулира.
 * - Силен идентификатор с различно име (общ телефон/домейн на клонове) → нов запис в DUPLICATE_REVIEW, извън новите.
 * - Само име+град съвпадение → нов запис в DUPLICATE_REVIEW (възможно е сменен телефон).
 * - Няколко различни съвпадения → review. Никакво сляпо сливане.
 */

/** Полета с политика на съхранение. DISPLAY_ONLY стойности никога не стигат до DB (виж stripRestricted). */
export type FieldPolicy = "STORE" | "DISPLAY_ONLY" | "ID_ONLY";

export interface CandidateInput {
  name: string;
  legalName?: string | null;
  city: string;
  address?: string | null;
  category: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  socialUrl?: string | null;
  socialActive?: boolean | null;
  mapsUrl?: string | null;
  eik?: string | null;
  placeId?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  ratingSource?: string | null;
  websiteStatus?: string;
  isChain?: boolean | null;
  phoneVerified?: boolean;
  contactPersonName?: string | null;
  contactPersonRole?: string | null;
  contactPersonSource?: string | null;
  source: "DEMO" | "CSV" | "XLSX" | "MANUAL" | "GOOGLE_PLACES" | "B2B";
  sourceRef?: string | null;
  sourceUrl?: string | null;
  sourceUsageConfirmed: boolean;
  fetchedAt?: Date | null;
  verifiedAt?: Date | null;
  confidence?: number | null;
  isDemo?: boolean;
  contactHistoryState: "NONE_CONFIRMED" | "HAS_HISTORY" | "UNKNOWN";
  firstIssuedAt?: Date | null;
  pipelineStage?: string;
  suggestedService?: string | null;
  estimatedValueCents?: number | null;
  notes?: string | null;
  /** policy на ниво поле; липсваща стойност = STORE */
  fieldPolicy?: Partial<Record<keyof CandidateInput, FieldPolicy>>;
}

/** Премахва полетата с ограничено съхранение ПРЕДИ каквото и да е записване/лог/export/AI payload. */
export function stripRestricted<T extends CandidateInput>(c: T): T {
  const out = { ...c };
  const policy = c.fieldPolicy ?? {};
  for (const [k, p] of Object.entries(policy)) {
    if (p === "DISPLAY_ONLY") (out as Record<string, unknown>)[k] = null;
  }
  delete out.fieldPolicy;
  return out;
}

export type IngestResult =
  | { kind: "created"; businessId: string; review: boolean; reason?: string }
  | { kind: "existing"; businessId: string; reason: string };

/** Нормализиран адрес за сравнение „име + адрес“ (без пощенски код, пунктуация и главни букви). */
export function normalizeAddress(a: string | null | undefined): string {
  return (a ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/(^|\D)\d{4}(?=\D|$)/g, "$1 ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * nameMatch: "city" (по подразбиране) — еднакво име в същия град води до проверка за дубликат;
 * "address" — еднакво име е сигнал само при еднакъв адрес (общо име само по себе си не доказва един бизнес).
 */
export async function ingestCandidate(t: Tx, raw: CandidateInput, now: Date, opts: { nameMatch?: "city" | "address" } = {}): Promise<IngestResult> {
  const c = stripRestricted(raw);
  const ids = identifiersFor({ name: c.name, city: c.city, phone: c.phone, website: c.website, eik: c.eik, placeId: c.placeId });
  const strong = ids.filter((i) => i.strong);
  const nameKey = normalizeName(c.name);

  const matches = await t.businessIdentifier.findMany({
    where: { OR: ids.map((i) => ({ type: i.type, value: i.value })) },
    include: { business: { select: { id: true, normalizedName: true, mergedIntoId: true, ref: true, address: true } } },
  });
  // Слят запис → каноничният.
  const canon = (b: { id: string; mergedIntoId: string | null }) => b.mergedIntoId ?? b.id;
  const strongHits = matches.filter((m) => strong.some((s) => s.type === m.type && s.value === m.value));
  const strongIds = new Set(strongHits.map((m) => canon(m.business)));
  const exactIdHit = strongHits.find((m) => m.type === "EIK" || m.type === "PLACE_ID");
  const sameNameHits = strongHits.filter((m) => m.business.normalizedName === nameKey);
  const sameNameIds = new Set(sameNameHits.map((m) => canon(m.business)));

  if (exactIdHit && strongIds.size === 1) {
    return { kind: "existing", businessId: canon(exactIdHit.business), reason: `Съвпадение по ${exactIdHit.type}` };
  }
  if (strongIds.size === 1 && sameNameIds.size === 1) {
    const id = [...sameNameIds][0]!;
    // Добавя нови aliases (напр. нов домейн), без да пипа история/статуси.
    for (const i of ids) {
      await t.businessIdentifier.upsert({
        where: { businessId_type_value: { businessId: id, type: i.type, value: i.value } },
        create: { businessId: id, type: i.type, value: i.value },
        update: {},
      });
    }
    return { kind: "existing", businessId: id, reason: "Съвпадение по силен идентификатор и име" };
  }

  const addrKey = normalizeAddress(c.address);
  const nameHits = matches.filter(
    (m) => m.type === "NAME_CITY" && (opts.nameMatch !== "address" || !addrKey || !m.business.address || normalizeAddress(m.business.address) === addrKey),
  );
  const conflictIds = new Set([...strongIds, ...nameHits.map((m) => canon(m.business))]);
  const review = conflictIds.size > 0;
  const relevant = matches.filter((m) => m.type !== "NAME_CITY" || nameHits.includes(m));
  const reviewReason = review
    ? `Възможен дубликат на ${[...new Set(relevant.map((m) => m.business.ref))].join(", ")} (${[...new Set(relevant.map((m) => m.type))].join("/")})`
    : null;

  const ph = normalizePhone(c.phone);
  const website = safeHttpUrl(c.website);
  const ref = await nextRef(t);
  const b = await t.business.create({
    data: {
      ref,
      name: c.name.trim(),
      legalName: c.legalName ?? null,
      normalizedName: nameKey,
      city: c.city.trim(),
      address: c.address ?? null,
      category: c.category,
      phoneRaw: ph?.raw ?? null,
      phoneNormalized: ph?.normalized ?? null,
      phoneKind: ph?.kind ?? null,
      phoneVerified: !!c.phoneVerified && ph?.kind !== "INVALID",
      email: c.email ?? null,
      website,
      websiteDomain: normalizeDomain(website),
      socialUrl: safeHttpUrl(c.socialUrl),
      socialActive: c.socialActive ?? null,
      mapsUrl: safeHttpUrl(c.mapsUrl),
      eik: c.eik ?? null,
      rating: c.rating ?? null,
      reviewCount: c.reviewCount ?? null,
      ratingSource: c.rating != null ? (c.ratingSource ?? null) : null,
      websiteStatus: c.websiteStatus ?? "UNCHECKED",
      isChain: c.isChain ?? null,
      contactPersonName: c.contactPersonName ?? null,
      contactPersonRole: c.contactPersonRole ?? null,
      contactPersonSource: c.contactPersonSource ?? null,
      source: c.source,
      sourceRef: c.sourceRef ?? null,
      sourceUrl: safeHttpUrl(c.sourceUrl),
      sourceUsageConfirmed: c.sourceUsageConfirmed,
      fetchedAt: c.fetchedAt ?? now,
      verifiedAt: c.verifiedAt ?? null,
      confidence: c.confidence ?? null,
      isDemo: !!c.isDemo,
      contactHistoryState: c.contactHistoryState,
      firstIssuedAt: c.firstIssuedAt ?? null,
      pipelineStage: c.pipelineStage ?? "NEW",
      reviewStatus: review ? "DUPLICATE_REVIEW" : ph?.kind === "INVALID" ? "NEEDS_CHECK" : "NONE",
      reviewReason: review ? reviewReason : ph?.kind === "INVALID" ? "Телефонът е с невалиден формат" : null,
      suggestedService: c.suggestedService ?? null,
      estimatedValueCents: c.estimatedValueCents ?? null,
      notes: c.notes ?? null,
    },
  });
  for (const i of ids) {
    await t.businessIdentifier.create({ data: { businessId: b.id, type: i.type, value: i.value, isPrimary: i.strong } });
  }
  if (review) {
    for (const other of conflictIds) {
      const hit = relevant.find((m) => canon(m.business) === other)!;
      await t.duplicateCandidate.upsert({
        where: { businessAId_businessBId_matchType: { businessAId: b.id, businessBId: other, matchType: hit.type } },
        create: { businessAId: b.id, businessBId: other, matchType: hit.type, matchValue: hit.value },
        update: {},
      });
    }
  }
  return { kind: "created", businessId: b.id, review, reason: reviewReason ?? undefined };
}
