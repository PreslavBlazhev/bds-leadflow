import type { DbLike } from "@/lib/db";
import type { Env } from "@/lib/env";
import { localDateOf } from "@/lib/time";

/**
 * Google Places API (New) — клиент за пилотното откриване (ЕИП условия).
 * - Text Search само с `places.id,nextPageToken` → SKU „Text Search Essentials (IDs Only)“ (безплатно по ценоразписа, 07.10.2026).
 * - Place Details с телефон/сайт/рейтинг → SKU „Place Details Enterprise“ (1000 безплатни/месец, после платено).
 * - Твърд месечен лимит в кода (ApiUsage) ПРЕДИ всяка заявка; над лимита заявката се отказва.
 * - Нищо от отговора освен place_id не се записва (EEA ToS: no caching; no copy/save of names, addresses, reviews).
 * - Fail-closed gate: real режим + ключ + потвърдени условия + LIVE_DISCOVERY_ENABLED.
 */

export const SKU_SEARCH_IDS = "places.text_search_ids";
export const SKU_DETAILS_ENTERPRISE = "places.details_enterprise";
export const DETAILS_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "primaryType",
  "primaryTypeDisplayName",
  "businessStatus",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "rating",
  "userRatingCount",
  "googleMapsUri",
].join(",");

export class PlacesBlockedError extends Error {}
export class PlacesBudgetError extends Error {}

export function placesGate(env: Pick<Env, "APP_MODE" | "GOOGLE_PLACES_API_KEY" | "GOOGLE_PLACES_TERMS_CONFIRMED" | "LIVE_DISCOVERY_ENABLED">): { ok: true } | { ok: false; reason: string } {
  if (env.APP_MODE !== "real") return { ok: false, reason: "Само в real режим (отделната реална база)." };
  if (!env.GOOGLE_PLACES_API_KEY) return { ok: false, reason: "Липсва GOOGLE_PLACES_API_KEY в .env.real." };
  if (!env.GOOGLE_PLACES_TERMS_CONFIRMED) return { ok: false, reason: "GOOGLE_PLACES_TERMS_CONFIRMED=false — първо прочети ограниченията за ЕИП (docs/DATA-SOURCES.md)." };
  if (!env.LIVE_DISCOVERY_ENABLED) return { ok: false, reason: "LIVE_DISCOVERY_ENABLED=false." };
  return { ok: true };
}

export interface PlaceLive {
  placeId: string;
  name: string | null;
  address: string | null;
  primaryType: string | null;
  typeLabel: string | null;
  businessStatus: string | null;
  phone: string | null;
  internationalPhone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  mapsUri: string | null;
}

type Fetch = typeof fetch;

/** Атомарно запазва квота: увеличава брояча само ако остава под лимита. */
export async function reserveQuota(db: DbLike, sku: string, cap: number, now: Date, n = 1): Promise<void> {
  const month = localDateOf(now).slice(0, 7);
  await db.apiUsage.upsert({ where: { month_sku: { month, sku } }, create: { month, sku, count: 0 }, update: {} });
  const r = await db.apiUsage.updateMany({ where: { month, sku, count: { lte: cap - n } }, data: { count: { increment: n } } });
  if (r.count !== 1) throw new PlacesBudgetError(`Месечният лимит за ${sku} (${cap}) е достигнат — заявката е отказана.`);
}

export interface PlacesClient {
  searchIds(p: { textQuery: string; includedType?: string; rect?: { low: [number, number]; high: [number, number] }; pageToken?: string }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  details(placeId: string): Promise<PlaceLive>;
}

export function createPlacesClient(db: DbLike, env: Env, now: () => Date, fetchImpl: Fetch = fetch): PlacesClient {
  const gate = placesGate(env);
  const guard = () => {
    if (!gate.ok) throw new PlacesBlockedError(gate.reason);
  };
  const key = () => env.GOOGLE_PLACES_API_KEY!;
  return {
    async searchIds(p) {
      guard();
      await reserveQuota(db, SKU_SEARCH_IDS, env.PLACES_MAX_SEARCH_PER_MONTH, now());
      const body: Record<string, unknown> = { textQuery: p.textQuery, pageSize: 20, languageCode: "bg", regionCode: "BG" };
      if (p.includedType) {
        body.includedType = p.includedType;
        body.strictTypeFiltering = true;
      }
      if (p.rect) body.locationRestriction = { rectangle: { low: { latitude: p.rect.low[0], longitude: p.rect.low[1] }, high: { latitude: p.rect.high[0], longitude: p.rect.high[1] } } };
      if (p.pageToken) body.pageToken = p.pageToken;
      const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "places.id,nextPageToken" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Places Text Search HTTP ${res.status}`);
      const j = (await res.json()) as { places?: { id: string }[]; nextPageToken?: string };
      return { ids: (j.places ?? []).map((x) => x.id).filter(Boolean), nextPageToken: j.nextPageToken ?? null };
    },
    async details(placeId) {
      guard();
      if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) throw new Error("Невалиден place_id");
      await reserveQuota(db, SKU_DETAILS_ENTERPRISE, env.PLACES_MAX_DETAILS_PER_MONTH, now());
      const res = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=bg&regionCode=BG`, {
        headers: { "X-Goog-Api-Key": key(), "X-Goog-FieldMask": DETAILS_FIELDS },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Places Details HTTP ${res.status}`);
      const j = (await res.json()) as Record<string, unknown> & { displayName?: { text?: string }; primaryTypeDisplayName?: { text?: string } };
      return {
        placeId: String(j.id ?? placeId),
        name: j.displayName?.text ?? null,
        address: (j.formattedAddress as string) ?? null,
        primaryType: (j.primaryType as string) ?? null,
        typeLabel: j.primaryTypeDisplayName?.text ?? null,
        businessStatus: (j.businessStatus as string) ?? null,
        phone: (j.nationalPhoneNumber as string) ?? null,
        internationalPhone: (j.internationalPhoneNumber as string) ?? null,
        website: (j.websiteUri as string) ?? null,
        rating: typeof j.rating === "number" ? j.rating : null,
        reviewCount: typeof j.userRatingCount === "number" ? j.userRatingCount : null,
        mapsUri: (j.googleMapsUri as string) ?? null,
      };
    },
  };
}

/** Категории BDS → типове от Table A (проверени в официалния списък, 07.10.2026). */
export const PILOT_TYPES: Record<string, string[]> = {
  restaurant: ["restaurant", "pizza_restaurant", "fast_food_restaurant"],
  auto: ["car_repair", "car_wash", "tire_shop"],
  beauty: ["beauty_salon", "hair_salon", "nail_salon", "barber_shop"],
  home: ["general_contractor", "plumber", "electrician", "roofing_contractor", "painter"],
};

/** Правоъгълници около градовете (приблизителни граници на града; Text Search връща до 60 резултата на заявка). */
export const PILOT_CITIES: Record<string, { low: [number, number]; high: [number, number] }> = {
  Варна: { low: [43.165, 27.82], high: [43.275, 28.0] },
  Плевен: { low: [43.385, 24.56], high: [43.445, 24.67] },
};
