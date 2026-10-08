import { z } from "zod";
import { audit, tx, type Ctx, type DbLike } from "@/lib/db";
import { CATEGORY_LABELS } from "./constants";
import { DomainError } from "./errors";
import { normalizeDomain, normalizeName, normalizePhone } from "./identity";
import { ingestCandidate } from "./ingest";
import { PILOT_CITIES, PILOT_TYPES, type PlaceLive, type PlacesClient } from "@/providers/googlePlaces";

/**
 * Първа реална проба (до 25 бизнеса) с Google Places при ЕИП условия:
 *  - в базата се пази само place_id + моите решения (PilotCandidate);
 *  - име/телефон/сайт/рейтинг се зареждат на живо за преглед и не се записват;
 *  - всеки кандидат се сравнява с МОЯТА импортирана история и DNC (телефон, домейн, име+град);
 *  - нищо не отива към обаждания без ръчно одобрение.
 */

export interface HistoryMatch {
  kind: "MATCH" | "NONE";
  businessId?: string;
  ref?: string;
  via?: string;
  dnc?: boolean;
  lastContactAt?: Date | null;
}

/** Сравнение с моите записи (стара история, DNC, всички статуси). Нищо не се записва. */
export async function matchHistory(db: DbLike, live: Pick<PlaceLive, "name" | "phone" | "internationalPhone" | "website">, city: string): Promise<HistoryMatch> {
  const keys: { type: string; value: string; via: string }[] = [];
  const ph = normalizePhone(live.internationalPhone ?? live.phone);
  if (ph?.normalized && ph.kind === "E164") keys.push({ type: "PHONE", value: ph.normalized, via: "телефон" });
  const dom = normalizeDomain(live.website);
  if (dom) keys.push({ type: "DOMAIN", value: dom, via: "сайт" });
  if (live.name) keys.push({ type: "NAME_CITY", value: `${normalizeName(live.name)}|${normalizeName(city)}`, via: "име + град" });
  if (!keys.length) return { kind: "NONE" };
  const hit = await db.businessIdentifier.findFirst({
    where: { OR: keys.map((k) => ({ type: k.type, value: k.value })) },
    include: { business: { select: { id: true, ref: true, lastContactAt: true, mergedIntoId: true, suppressions: { where: { liftedAt: null, type: "DNC" }, select: { id: true } } } } },
  });
  if (!hit) return { kind: "NONE" };
  return {
    kind: "MATCH",
    businessId: hit.business.mergedIntoId ?? hit.business.id,
    ref: hit.business.ref,
    via: keys.find((k) => k.type === hit.type)?.via ?? hit.type,
    dnc: hit.business.suppressions.length > 0,
    lastContactAt: hit.business.lastContactAt,
  };
}

/** Колко от МОЯТА стара история е импортирана — за честно предупреждение. */
export async function historyCoverage(db: DbLike) {
  const [imported, withHistory, total] = await Promise.all([
    db.business.count({ where: { source: "CSV" } }),
    db.business.count({ where: { contactHistoryState: "HAS_HISTORY" } }),
    db.business.count({ where: { mergedIntoId: null } }),
  ]);
  return { imported, withHistory, total, guaranteed: false as const };
}

export function missingFields(live: PlaceLive): string[] {
  const m: string[] = [];
  if (!live.phone && !live.internationalPhone) m.push("Няма телефон в профила");
  if (!live.website) m.push("Няма сайт в профила (не доказва, че няма сайт)");
  if (live.rating === null) m.push("Няма рейтинг");
  if (!live.address) m.push("Няма адрес");
  if (live.businessStatus && live.businessStatus !== "OPERATIONAL") m.push(`Статус: ${live.businessStatus}`);
  return m;
}

export interface PilotPlan {
  queries: { city: string; category: string; type: string; textQuery: string }[];
  maxSearchRequests: number;
  maxDetailsRequests: number;
  notes: string[];
}

export function planPilot(opts: { limit: number; maxEvaluations: number }): PilotPlan {
  const queries: PilotPlan["queries"] = [];
  for (const city of Object.keys(PILOT_CITIES)) {
    for (const [category, types] of Object.entries(PILOT_TYPES)) {
      for (const type of types) queries.push({ city, category, type, textQuery: `${CATEGORY_LABELS[category]?.split("/")[0] ?? type} ${city}` });
    }
  }
  return {
    queries,
    maxSearchRequests: queries.length * 3, // до 3 страници × 20 = 60 резултата на заявка
    maxDetailsRequests: opts.maxEvaluations,
    notes: [
      "Text Search само с place_id (SKU „Essentials (IDs Only)“) — безплатно по ценоразписа от 07.10.2026.",
      `Place Details Enterprise (телефон/сайт/рейтинг): най-много ${opts.maxEvaluations} заявки за тази проба — в рамките на 1000 безплатни/месец.`,
      `Спира при ${opts.limit} одобрими кандидата или при изчерпан лимит.`,
    ],
  };
}

export interface DiscoverResult {
  searchRequests: number;
  detailsRequests: number;
  pending: number;
  inHistory: number;
  skipped: number;
  alreadyKnown: number;
  stoppedBy: "limit" | "evaluations" | "exhausted";
}

/** Откриване: търсене само по ID (безплатно) → детайли само за непознати place_id → проверка → PilotCandidate. */
export async function discoverPilot(ctx: Ctx, client: PlacesClient, opts: { limit: number; maxEvaluations: number; cities?: string[] }): Promise<DiscoverResult> {
  const plan = planPilot(opts);
  const r: DiscoverResult = { searchRequests: 0, detailsRequests: 0, pending: 0, inHistory: 0, skipped: 0, alreadyKnown: 0, stoppedBy: "exhausted" };
  r.pending = await ctx.db.pilotCandidate.count({ where: { status: "PENDING_REVIEW" } });
  // Редуване: 1-ви тип на всяка категория във всеки град, после 2-ри тип и т.н. — разнообразна проба.
  const queries: PilotPlan["queries"] = [];
  const maxTypes = Math.max(...Object.values(PILOT_TYPES).map((t) => t.length));
  for (let i = 0; i < maxTypes; i++) {
    for (const category of Object.keys(PILOT_TYPES)) {
      for (const city of Object.keys(PILOT_CITIES)) {
        if (opts.cities && !opts.cities.includes(city)) continue;
        const q = plan.queries.find((x) => x.city === city && x.category === category && x.type === PILOT_TYPES[category]![i]);
        if (q) queries.push(q);
      }
    }
  }
  for (const q of queries) {
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      if (r.pending >= opts.limit) return { ...r, stoppedBy: "limit" };
      if (r.detailsRequests >= opts.maxEvaluations) return { ...r, stoppedBy: "evaluations" };
      const s = await client.searchIds({ textQuery: q.textQuery, includedType: q.type, rect: PILOT_CITIES[q.city], pageToken });
      r.searchRequests++;
      for (const placeId of s.ids) {
        if (r.pending >= opts.limit || r.detailsRequests >= opts.maxEvaluations) break;
        const known = (await ctx.db.pilotCandidate.findUnique({ where: { placeId } })) || (await ctx.db.businessIdentifier.findFirst({ where: { type: "PLACE_ID", value: placeId } }));
        if (known) {
          r.alreadyKnown++;
          continue; // без платена заявка за вече виждани места
        }
        const live = await client.details(placeId);
        r.detailsRequests++;
        let status = "PENDING_REVIEW";
        let matchedBusinessId: string | null = null;
        if ((live.businessStatus && live.businessStatus !== "OPERATIONAL") || (!live.phone && !live.internationalPhone)) status = "SKIPPED";
        else {
          const m = await matchHistory(ctx.db, live, q.city);
          if (m.kind === "MATCH") {
            status = "IN_HISTORY";
            matchedBusinessId = m.businessId ?? null;
          }
        }
        await ctx.db.pilotCandidate.create({ data: { placeId, city: q.city, category: q.category, query: `${q.type}: ${q.textQuery}`, status, matchedBusinessId } });
        if (status === "PENDING_REVIEW") r.pending++;
        else if (status === "IN_HISTORY") r.inHistory++;
        else r.skipped++;
      }
      if (!s.nextPageToken) break;
      pageToken = s.nextPageToken;
    }
  }
  await audit(ctx.db, ctx.actor, "pilot.discover", undefined, undefined, r);
  return r;
}

/** Данни за преглед — зареждат се на живо, не се записват. Съвпадението с историята се проверява наново. */
export async function pilotLiveView(ctx: Ctx, client: PlacesClient, id: string) {
  const c = await ctx.db.pilotCandidate.findUnique({ where: { id } });
  if (!c) throw new DomainError("NOT_FOUND", "Кандидатът не е намерен.");
  const live = await client.details(c.placeId);
  const history = await matchHistory(ctx.db, live, c.city);
  return { id: c.id, status: c.status, city: c.city, category: c.category, live, missing: missingFields(live), history, source: "Google Maps (Places API, зареден на живо, не е записан)" };
}

export const reviewInput = z.object({ id: z.string(), decision: z.enum(["APPROVED", "REJECTED", "PENDING_REVIEW"]), note: z.string().max(500).optional() });

export async function reviewPilot(ctx: Ctx, raw: z.input<typeof reviewInput>) {
  const v = reviewInput.parse(raw);
  const c = await ctx.db.pilotCandidate.findUnique({ where: { id: v.id } });
  if (!c) throw new DomainError("NOT_FOUND", "Кандидатът не е намерен.");
  if (c.status === "CONVERTED") throw new DomainError("CONFLICT", "Вече е превърнат в мой запис.");
  if (c.status === "IN_HISTORY" && v.decision === "APPROVED") throw new DomainError("CONFLICT", "Съвпада с моя история/DNC — не може да се одобри като нов.");
  const u = await ctx.db.pilotCandidate.update({ where: { id: v.id }, data: { status: v.decision, reviewNote: v.note ?? null, reviewedAt: ctx.clock.now() } });
  await audit(ctx.db, ctx.actor, "pilot.review", "PilotCandidate", v.id, { decision: v.decision });
  return u;
}

export const convertInput = z.object({
  id: z.string(),
  name: z.string().min(2).max(200),
  phone: z.string().min(6).max(40),
  website: z.string().max(300).optional(),
  confirmedWithBusiness: z.literal(true, { error: "Потвърди, че данните са потвърдени от бизнеса в разговора." }),
});

/**
 * След реален разговор: създава МОЙ CRM запис с данни, потвърдени директно от бизнеса.
 * Връзката с Google е само place_id (разрешено за съхранение). Отбелязано е изрично в sourceRef.
 */
export async function convertPilot(ctx: Ctx, raw: z.input<typeof convertInput>) {
  const v = convertInput.parse(raw);
  const c = await ctx.db.pilotCandidate.findUnique({ where: { id: v.id } });
  if (!c) throw new DomainError("NOT_FOUND", "Кандидатът не е намерен.");
  if (c.status !== "APPROVED") throw new DomainError("CONFLICT", "Само одобрен кандидат може да се запише след разговор.");
  const now = ctx.clock.now();
  return tx(ctx.db, async (t) => {
    const r = await ingestCandidate(
      t,
      {
        name: v.name,
        city: c.city,
        category: c.category,
        phone: v.phone,
        website: v.website,
        placeId: c.placeId,
        source: "MANUAL",
        sourceRef: `Данните са потвърдени от бизнеса в разговор (${now.toISOString().slice(0, 10)}); открит чрез Google Places place_id`,
        sourceUsageConfirmed: true,
        verifiedAt: now,
        contactHistoryState: "UNKNOWN", // става HAS_HISTORY при записване на резултата
      },
      now,
    );
    await t.pilotCandidate.update({ where: { id: c.id }, data: { status: "CONVERTED", businessId: r.businessId } });
    await audit(t, ctx.actor, "pilot.convert", "Business", r.businessId, { pilotId: c.id, result: r.kind });
    return r;
  });
}
