import type { Ctx } from "@/lib/db";
import { tx } from "@/lib/db";
import type { Env } from "@/lib/env";
import { ingestCandidate, type CandidateInput } from "@/domain/ingest";

/**
 * Provider abstraction. Всеки provider декларира capabilities и разрешения за съхранение.
 * Реализирани: DemoProvider (синтетичен, без мрежа), CSV/ръчен (src/domain/importCsv.ts, crm.ts).
 * Интерфейси: B2B (BLOCKED), Google Places read-through (BLOCKED до потвърдени условия + ключ + e2e проверка).
 */
export interface ProviderCapabilities {
  discover: boolean;
  enrich: boolean;
  refresh: boolean;
  storage: "FULL" | "PLACE_ID_ONLY" | "NONE";
  derivedUseAllowed: boolean;
  quotaPerDay: number | null;
}

export interface DemoDiscovery {
  key: string;
  label: string;
  capabilities: ProviderCapabilities;
  discover(ctx: Ctx, wanted: number): Promise<{ created: number; existing: number; review: number }>;
}

/* ---------------- DemoProvider: детерминирани синтетични данни ---------------- */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAT_NOUN: Record<string, string[]> = {
  restaurant: ["Пицария", "Ресторант", "Механа", "Бистро"],
  auto: ["Автосервиз", "Автомивка", "Гуми Сервиз", "Автоелектрик"],
  beauty: ["Салон", "Студио Красота", "Маникюр Студио", "Фризьорски Салон"],
  home: ["Ремонти", "Строителна Фирма", "ВиК Услуги", "Дограма"],
};
const CATS = ["restaurant", "auto", "beauty", "home"];
export const DEMO_OTHER_CITIES = ["Русе", "Бургас", "Шумен", "Добрич", "Ловеч"];

export interface DemoRecordExtras {
  audit: { result: string; https: boolean | null; hasViewport: boolean | null; contactVisible: boolean | null; poorMobile: boolean | null; strongModern: boolean | null; issues: string[]; evidence: string } | null;
  reviews: { author: string; text: string; rating: number; reviewDate: string }[];
}

/** Детерминиран синтетичен бизнес №i. Няма реални имена, телефони или домейни. */
export function demoRecord(i: number, now: Date): { input: CandidateInput; extras: DemoRecordExtras } {
  const r = mulberry32(i * 7919 + 17);
  const category = CATS[i % 4]!;
  const nouns = CAT_NOUN[category]!;
  const noun = nouns[Math.floor(r() * nouns.length)]!;
  const cityRoll = r();
  const city = cityRoll < 0.55 ? "Варна" : cityRoll < 0.8 ? "Плевен" : DEMO_OTHER_CITIES[Math.floor(r() * DEMO_OTHER_CITIES.length)]!;
  const num = String(i).padStart(3, "0");
  const siteRoll = r();
  let websiteStatus: string;
  let website: string | null = null;
  let audit: DemoRecordExtras["audit"] = null;
  if (siteRoll < 0.35) {
    websiteStatus = "NOT_FOUND_AFTER_CHECK";
    audit = { result: "NOT_FOUND", https: null, hasViewport: null, contactVisible: null, poorMobile: null, strongModern: null, issues: [], evidence: "СИНТЕТИЧНО: търсене по име+град в demo каталога не откри сайт." };
  } else if (siteRoll < 0.65) {
    websiteStatus = "FOUND";
    website = `https://demo-${num}.example.invalid`;
    const noViewport = r() < 0.6;
    const issues = [r() < 0.5 ? "няма HTTPS" : null, noViewport ? "няма mobile viewport meta" : null, r() < 0.4 ? "не се вижда телефон/CTA на началната страница" : null].filter(Boolean) as string[];
    // Липсващ viewport таг сам по себе си НЕ доказва лош вид на телефон — „потвърдено“ е само при отделна (синтетична) ръчна проверка.
    const phoneChecked = noViewport && r() < 0.3;
    audit = {
      result: "REACHABLE",
      https: !issues.includes("няма HTTPS"),
      hasViewport: !noViewport,
      contactVisible: !issues.some((x) => x.startsWith("не се вижда")),
      poorMobile: phoneChecked ? true : null,
      strongModern: false,
      issues,
      evidence: phoneChecked
        ? "СИНТЕТИЧНО: проверка на началната страница + ръчно отваряне на телефон (дребен текст, менюто не се побира)."
        : "СИНТЕТИЧНО: проверка само на началната страница; мобилният вид не е проверен на телефон.",
    };
  } else if (siteRoll < 0.78) {
    websiteStatus = "FOUND";
    website = `https://demo-${num}.example.invalid`;
    audit = { result: "REACHABLE", https: true, hasViewport: true, contactVisible: true, poorMobile: false, strongModern: true, issues: [], evidence: "СИНТЕТИЧНО: HTTPS, viewport и видими контакти/CTA." };
  } else if (siteRoll < 0.86) {
    websiteStatus = "UNREACHABLE";
    website = `https://demo-${num}.example.invalid`;
    audit = { result: "UNREACHABLE", https: null, hasViewport: null, contactVisible: null, poorMobile: null, strongModern: null, issues: [], evidence: "СИНТЕТИЧНО: timeout — не е доказателство за слаб сайт." };
  } else {
    websiteStatus = "UNCHECKED";
  }
  const hasRating = r() < 0.8;
  const rating = hasRating ? Math.round((3.4 + r() * 1.6) * 10) / 10 : null;
  const reviewCount = hasRating ? Math.floor(r() * 180) + 1 : null;
  const reviews: DemoRecordExtras["reviews"] = [];
  if (hasRating && r() < 0.5) {
    reviews.push({ author: `Демо потребител ${(i * 3) % 97}`, text: "ДЕМО отзив: измислен текст за демонстрация.", rating: Math.min(5, Math.max(1, Math.round(rating!))), reviewDate: "2026-09-15" });
  }
  const verifiedAt = new Date(now.getTime() - Math.floor(r() * 10) * 86_400_000);
  const services: Record<string, string> = { restaurant: "Сайт с дигитално меню", auto: "Сайт + онлайн записване", beauty: "Сайт + онлайн записване", home: "Сайт визитка с галерия" };
  return {
    input: {
      name: `ДЕМО ${noun} ${num}`,
      city,
      address: `${city}, ДЕМО ул. ${(i % 40) + 1}`,
      category,
      phone: `DEMO-${String(i).padStart(4, "0")}`,
      website,
      socialUrl: r() < 0.6 ? `https://social-${num}.example.invalid` : null,
      socialActive: r() < 0.5 ? true : r() < 0.5 ? false : null,
      rating,
      reviewCount,
      ratingSource: hasRating ? "DEMO (синтетичен рейтинг)" : null,
      websiteStatus,
      isChain: r() < 0.05 ? true : r() < 0.7 ? false : null,
      phoneVerified: r() < 0.85,
      source: "DEMO",
      sourceRef: `demo:${i}`,
      sourceUrl: null,
      sourceUsageConfirmed: true,
      fetchedAt: verifiedAt,
      verifiedAt,
      confidence: 1,
      isDemo: true,
      contactHistoryState: "NONE_CONFIRMED",
      suggestedService: services[category],
      estimatedValueCents: [45000, 70000, 95000][i % 3],
    },
    extras: { audit, reviews },
  };
}

export async function insertDemoRecord(ctx: Ctx, i: number, overrides: Partial<CandidateInput> = {}) {
  const now = ctx.clock.now();
  const { input, extras } = demoRecord(i, now);
  return tx(ctx.db, async (t) => {
    const r = await ingestCandidate(t, { ...input, ...overrides }, now);
    if (r.kind === "created") {
      if (extras.audit) {
        await t.websiteAudit.create({ data: { businessId: r.businessId, checkedAt: input.verifiedAt ?? now, url: input.website ?? null, ...extras.audit, issues: JSON.stringify(extras.audit.issues), synthetic: true } });
      }
      for (const rv of extras.reviews) await t.businessReview.create({ data: { businessId: r.businessId, source: "DEMO", isDemo: true, url: null, ...rv } });
      await t.sourceEvidence.create({
        data: { businessId: r.businessId, provider: "DEMO", field: "*", fetchedAt: now, verifiedAt: input.verifiedAt, storageAllowed: true, derivedUseAllowed: true, synthetic: true, note: "Синтетични demo данни" },
      });
    }
    return r;
  });
}

export function demoProvider(): DemoDiscovery {
  return {
    key: "demo",
    label: "DemoProvider",
    capabilities: { discover: true, enrich: false, refresh: false, storage: "FULL", derivedUseAllowed: true, quotaPerDay: 60 },
    async discover(ctx, wanted) {
      if (ctx.mode !== "demo") throw new Error("DemoProvider е забранен в real режим.");
      const n = Math.min(Math.max(wanted, 0), 60);
      const res = { created: 0, existing: 0, review: 0 };
      for (let k = 0; k < n; k++) {
        const c = await ctx.db.counter.upsert({ where: { name: "demoIndex" }, create: { name: "demoIndex", value: 401 }, update: { value: { increment: 1 } } });
        const r = await insertDemoRecord(ctx, c.value);
        if (r.kind === "existing") res.existing++;
        else if (r.review) res.review++;
        else res.created++;
      }
      return res;
    },
  };
}

/* ---------------- Бъдещ лицензиран B2B provider — само интерфейс ---------------- */

export interface B2BProvider {
  key: string;
  capabilities: ProviderCapabilities;
  /** Връща кандидати с field policy; реален endpoint НЕ е измислен — нужен е договор и документация. */
  search(params: { city: string; category: string; limit: number }): Promise<CandidateInput[]>;
}

/* ---------------- Google Places read-through (BLOCKED) ---------------- */

export interface PlaceDisplay {
  placeId: string; // ID_ONLY: Place ID може да се съхранява
  display: { name?: string; phone?: string; website?: string; rating?: number; userRatingCount?: number; mapsUri?: string; reviews?: { author: string; authorUri?: string; text: string; relativeTime?: string }[] }; // DISPLAY_ONLY
  attribution: string;
}

export class ProviderBlockedError extends Error {}

/**
 * Read-through: показва детайли на живо по Place ID. Нищо от `display` не се записва в DB, logs,
 * score snapshots, exports или AI prompts — само placeId. Fail-closed gate.
 */
export function googlePlacesGate(env: Env): { ok: true } | { ok: false; reason: string } {
  if (env.APP_MODE !== "real") return { ok: false, reason: "DEMO_MODE: без външни заявки." };
  if (!env.GOOGLE_PLACES_API_KEY) return { ok: false, reason: "Липсва GOOGLE_PLACES_API_KEY." };
  if (!env.GOOGLE_PLACES_TERMS_CONFIRMED) return { ok: false, reason: "Условията за ЕИП/CRM употреба не са потвърдени." };
  if (!env.LIVE_DISCOVERY_ENABLED) return { ok: false, reason: "LIVE_DISCOVERY_ENABLED=false." };
  return { ok: true };
}

export async function fetchPlaceDisplay(env: Env, placeId: string, fetchImpl: typeof fetch = fetch): Promise<PlaceDisplay> {
  const gate = googlePlacesGate(env);
  if (!gate.ok) throw new ProviderBlockedError(gate.reason);
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error("Невалиден Place ID");
  const res = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY!,
      "X-Goog-FieldMask": "id,displayName,internationalPhoneNumber,websiteUri,rating,userRatingCount,googleMapsUri,reviews",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Places API HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown> & { reviews?: { authorAttribution?: { displayName?: string; uri?: string }; text?: { text?: string }; relativePublishTimeDescription?: string }[] };
  return {
    placeId: String(j.id ?? placeId),
    display: {
      name: (j.displayName as { text?: string } | undefined)?.text,
      phone: j.internationalPhoneNumber as string | undefined,
      website: j.websiteUri as string | undefined,
      rating: j.rating as number | undefined,
      userRatingCount: j.userRatingCount as number | undefined,
      mapsUri: j.googleMapsUri as string | undefined,
      reviews: (j.reviews ?? []).map((r) => ({ author: r.authorAttribution?.displayName ?? "", authorUri: r.authorAttribution?.uri, text: r.text?.text ?? "", relativeTime: r.relativePublishTimeDescription })),
    },
    attribution: "Google Maps",
  };
}
