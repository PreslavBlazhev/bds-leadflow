import { afterEach, describe, expect, it, vi } from "vitest";
import { commitImport } from "@/domain/csv";
import { convertPilot, discoverPilot, historyCoverage, pilotLiveView, reviewPilot } from "@/domain/pilot";
import type { Env } from "@/lib/env";
import { createPlacesClient, PlacesBlockedError, PlacesBudgetError, placesGate } from "@/providers/googlePlaces";
import { closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const env = (o: Partial<Env> = {}) =>
  ({ APP_MODE: "real", GOOGLE_PLACES_API_KEY: "test-key-not-real", GOOGLE_PLACES_TERMS_CONFIRMED: true, LIVE_DISCOVERY_ENABLED: true, PLACES_MAX_DETAILS_PER_MONTH: 900, PLACES_MAX_SEARCH_PER_MONTH: 2000, ...o }) as Env;

// Фалшив Places API: 3 страници по 4 места; детайлите са синтетични (валидни формати, никога не се набират).
function fakePlaces() {
  const calls = { search: 0, details: 0 };
  const places: Record<string, Record<string, unknown>> = {};
  const mk = (i: number, extra: Record<string, unknown> = {}) => {
    const id = `ChIJ_fake_place_${String(i).padStart(4, "0")}`;
    places[id] = { id, displayName: { text: `ФАЛШИВ Бизнес ${i}` }, formattedAddress: `ул. Тест ${i}, Варна`, primaryType: "restaurant", businessStatus: "OPERATIONAL", nationalPhoneNumber: `088 900 ${String(1000 + i)}`, internationalPhoneNumber: `+359 88 900 ${String(1000 + i)}`, websiteUri: i % 2 ? `https://fake-${i}.example.invalid` : undefined, rating: 4.5, userRatingCount: 30, googleMapsUri: `https://maps.google.com/?cid=${i}`, ...extra };
    return id;
  };
  const ids: string[] = [];
  for (let i = 1; i <= 40; i++) ids.push(mk(i, i === 2 ? { nationalPhoneNumber: undefined, internationalPhoneNumber: undefined } : i === 3 ? { businessStatus: "CLOSED_PERMANENTLY" } : {}));
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(":searchText")) {
      calls.search++;
      const body = JSON.parse(String(init!.body)) as { pageToken?: string };
      expect((init!.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("places.id,nextPageToken"); // само ID → безплатен SKU
      const page = body.pageToken ? Number(body.pageToken) : 0;
      const slice = ids.slice(page * 4, page * 4 + 4);
      return new Response(JSON.stringify({ places: slice.map((id) => ({ id })), nextPageToken: page < 2 ? String(page + 1) : undefined }), { status: 200 });
    }
    calls.details++;
    const id = decodeURIComponent(url.split("/places/")[1]!.split("?")[0]!);
    return new Response(JSON.stringify(places[id]), { status: 200 });
  });
  return { f, calls };
}

describe("пилот с Google Places (фалшив API, без мрежа)", () => {
  it("gate: demo режим, липсващ ключ или непотвърдени условия → BLOCKED без заявка", async () => {
    expect(placesGate(env({ APP_MODE: "demo" })).ok).toBe(false);
    expect(placesGate(env({ GOOGLE_PLACES_API_KEY: undefined })).ok).toBe(false);
    expect(placesGate(env({ GOOGLE_PLACES_TERMS_CONFIRMED: false })).ok).toBe(false);
    ctx = await testDb({ mode: "real" });
    const { f } = fakePlaces();
    const c = createPlacesClient(ctx.db, env({ LIVE_DISCOVERY_ENABLED: false }), () => ctx.clock.now(), f as never);
    await expect(c.searchIds({ textQuery: "x" })).rejects.toThrow(PlacesBlockedError);
    expect(f).not.toHaveBeenCalled();
  });

  it("откриване: само place_id в базата, история/без телефон/затворени се отсяват, спира на лимита", async () => {
    ctx = await testDb({ mode: "real" });
    // моята стара история: бизнес със същия телефон като място №5
    const hist = await commitImport(ctx, { filename: "old.csv", text: "Business Name,Business Type,City,Phone,contacted_before,Last Contact\nСтар клиент,Ресторант,Варна,+359889001005,yes,01.09.2026\n", usageConfirmed: true });
    expect(hist.counts.created).toBe(1);
    const { f, calls } = fakePlaces();
    const client = createPlacesClient(ctx.db, env(), () => ctx.clock.now(), f as never);
    const r = await discoverPilot(ctx, client, { limit: 5, maxEvaluations: 20, cities: ["Варна"] });
    expect(r.pending).toBe(5);
    expect(r.stoppedBy).toBe("limit");
    expect(r.inHistory).toBe(1); // №5 съвпада по телефон с моята история
    expect(r.skipped).toBe(2); // №2 без телефон, №3 затворен
    expect(calls.details).toBe(8);
    const rows = await ctx.db.pilotCandidate.findMany();
    expect(rows.find((x) => x.placeId.endsWith("0005"))?.status).toBe("IN_HISTORY");
    // в базата НЯМА Google съдържание (имена, адреси, телефони, рейтинги) — само place_id
    const dump = JSON.stringify([await ctx.db.pilotCandidate.findMany(), await ctx.db.business.findMany(), await ctx.db.businessIdentifier.findMany(), await ctx.db.auditLog.findMany()]);
    expect(dump).not.toMatch(/ФАЛШИВ Бизнес|ул\. Тест|88 900 10(0[1-4]|0[6-9])|fake-\d/);
    // бюджетен брояч
    const usage = await ctx.db.apiUsage.findMany();
    expect(usage.find((u) => u.sku === "places.details_enterprise")?.count).toBe(8);
    // повторно пускане: вече виждани place_id не струват нови Place Details
    const before = calls.details;
    const r2 = await discoverPilot(ctx, client, { limit: 6, maxEvaluations: 20, cities: ["Варна"] });
    expect(r2.alreadyKnown).toBeGreaterThanOrEqual(8);
    expect(calls.details - before).toBe(1);
    expect(await historyCoverage(ctx.db)).toMatchObject({ imported: 1 });
  });

  it("бюджетен лимит се прилага ПРЕДИ заявката", async () => {
    ctx = await testDb({ mode: "real" });
    const { f, calls } = fakePlaces();
    const client = createPlacesClient(ctx.db, env({ PLACES_MAX_DETAILS_PER_MONTH: 3 }), () => ctx.clock.now(), f as never);
    await expect(discoverPilot(ctx, client, { limit: 25, maxEvaluations: 50, cities: ["Варна"] })).rejects.toThrow(PlacesBudgetError);
    expect(calls.details).toBe(3);
  });

  it("преглед и запис след разговор: в историята не се одобрява; запис само с потвърждение; пази се place_id", async () => {
    ctx = await testDb({ mode: "real" });
    await commitImport(ctx, { filename: "old.csv", text: "Business Name,Business Type,City,Phone,contacted_before\nСтар,Ресторант,Варна,+359889001005,yes\n", usageConfirmed: true });
    const { f } = fakePlaces();
    const client = createPlacesClient(ctx.db, env(), () => ctx.clock.now(), f as never);
    await discoverPilot(ctx, client, { limit: 3, maxEvaluations: 10, cities: ["Варна"] });
    const inHist = await ctx.db.pilotCandidate.findFirstOrThrow({ where: { status: "IN_HISTORY" } });
    await expect(reviewPilot(ctx, { id: inHist.id, decision: "APPROVED" })).rejects.toThrow(/история/);
    const pending = await ctx.db.pilotCandidate.findFirstOrThrow({ where: { status: "PENDING_REVIEW" } });
    const view = await pilotLiveView(ctx, client, pending.id);
    expect(view.live.name).toMatch(/ФАЛШИВ/);
    expect(view.history.kind).toBe("NONE");
    expect(view.source).toMatch(/не е записан/);
    await expect(convertPilot(ctx, { id: pending.id, name: "Тест", phone: "0889001001", confirmedWithBusiness: true })).rejects.toThrow(/одобрен/);
    await reviewPilot(ctx, { id: pending.id, decision: "APPROVED", note: "ок" });
    await expect(convertPilot(ctx, { id: pending.id, name: "Тест", phone: "0889001001", confirmedWithBusiness: false as never })).rejects.toThrow();
    const r = await convertPilot(ctx, { id: pending.id, name: "Име от разговора", phone: "0889001001", confirmedWithBusiness: true });
    const b = await ctx.db.business.findUniqueOrThrow({ where: { id: r.businessId }, include: { identifiers: true } });
    expect(b.source).toBe("MANUAL");
    expect(b.identifiers.map((i) => i.type)).toContain("PLACE_ID");
    expect(b.sourceRef).toMatch(/потвърдени от бизнеса/);
    expect((await ctx.db.pilotCandidate.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CONVERTED");
  });
});
