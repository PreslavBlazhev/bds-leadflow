import { afterEach, describe, expect, it } from "vitest";
import { publishDailyBatch } from "@/domain/batch";
import { buildCallQueues } from "@/domain/callQueue";
import { tx } from "@/lib/db";
import { ingestCandidate } from "@/domain/ingest";
import { recordOutcome } from "@/domain/outcomes";
import { getSettings, saveSettings } from "@/domain/settings";
import { EXPECTED_HEADERS, importBusinessFile, parseBusinessFile, parseRanges } from "@/domain/xlsxImport";
import { extractHyperlinkUrl } from "@/lib/xlsx";
import { addDays, zonedToUtc } from "@/lib/time";
import { addLeads, closeDb, testDb, type TestCtx } from "./helpers";
import { buildXlsx, type FxCell } from "./xlsxFixture";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const serial = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 25569;
const CATS = ["Автоуслуги", "Красота и грижа", "Храни и заведения", "Магазини", "Грижа за животни"];
const mapsUrl = (i: number) =>
  `https://www.google.com/maps/place/%D0%A2%D0%95%D0%A1%D0%A2+${i}/data=!4m7!3m6!1s0x0:0x${i.toString(16)}!8m2!3d43.2!4d27.9!16s%2Fg%2F11test${i}!19sChIJTEST${String(i).padStart(4, "0")}xyz?authuser=0&hl=en`;

/** Синтетичен файл със същата структура като проучването (валидни по формат, никога не набирани номера). */
function fixture(n = 70) {
  const rows: FxCell[][] = [[...EXPECTED_HEADERS]];
  for (let i = 1; i <= n; i++) {
    const u = mapsUrl(i);
    // Нечетните — разделени в _xlfn._LONGTEXT (като дългите адреси във файла); кешът е само „Google Maps“.
    const maps = i % 2 ? { f: `IFERROR(HYPERLINK(_xlfn._LONGTEXT("${u.slice(0, 90)}","${u.slice(90)}"),"Google Maps"),"Google Maps")`, v: "Google Maps" } : { f: `IFERROR(HYPERLINK("${u}","Google Maps"),"Google Maps")`, v: "Google Maps" };
    rows.push([
      i,
      `ТЕСТ Бизнес ${i}`,
      CATS[i % CATS.length]!,
      "Подкатегория",
      i % 3 ? "Център" : null,
      `ул. Тестова ${i}, 9000 Варна`,
      `+35988900${String(1000 + i)}`,
      i === 7 ? `+35988911${String(1000 + i)}` : null,
      maps,
      4.5,
      30 + i,
      "Пн–Пт: 09:00–18:00",
      i % 3 === 0 ? "Само Facebook/Instagram" : "Няма открит собствен сайт",
      i % 3 === 0 ? { f: `IFERROR(HYPERLINK("https://www.facebook.com/test.${i}/","Facebook"),"Facebook")`, v: "Facebook" } : null,
      null,
      null,
      "Преди 2 месеца (видим отзив)",
      serial("2026-10-01"),
      "Средна",
      null,
      i % 2 ? "A — висок приоритет" : "B — среден приоритет",
    ]);
  }
  return buildXlsx([
    { name: "Основен списък", rows },
    { name: "Неработещи сайтове", rows: [[...EXPECTED_HEADERS], [null, "Няма потвърдени случаи."]] },
    { name: "Без публикуван телефон", rows: [[...EXPECTED_HEADERS], [1, "Без телефон 1"]] },
  ]);
}

const called = parseRanges("1-20,51-65");

describe("импорт на реални бизнеси от Excel", () => {
  it("формули: само HYPERLINK/IFERROR/_LONGTEXT; _LONGTEXT се съединява; друго се отказва", () => {
    expect(extractHyperlinkUrl(`IFERROR(HYPERLINK(_xlfn._LONGTEXT("https://a.bg/x","y?z=1"),"Google Maps"),"Google Maps")`)).toBe("https://a.bg/xy?z=1");
    expect(extractHyperlinkUrl(`HYPERLINK("https://b.bg/""q""","Профил")`)).toBe('https://b.bg/"q"');
    expect(() => extractHyperlinkUrl(`HYPERLINK(A1,"x")`)).toThrow();
    expect(() => extractHyperlinkUrl(`HYPERLINK(WEBSERVICE("https://evil"),"x")`)).toThrow();
    const p = parseBusinessFile(fixture(), "test.xlsx");
    expect(p.sheetCounts).toMatchObject({ "Основен списък": 70, "Неработещи сайтове": 0, "Без публикуван телефон": 1 });
    expect(p.rows[0]!.mapsUrl).toBe(mapsUrl(1)); // дълъг (_LONGTEXT)
    expect(p.rows[1]!.mapsUrl).toBe(mapsUrl(2)); // кратък
    expect(p.rows[0]!.placeId).toBe("ChIJTEST0001xyz");
    expect(p.rows[2]!.facebookUrl).toBe("https://www.facebook.com/test.3/");
    expect(p.rows[0]!.checkedOn).toBe("2026-10-01");
    expect(p.linkStats.longText).toBe(35);
  });

  it("история по „Пореден номер“, предимство на CRM/DNC, повторен импорт без дубликати, реални списъци без демо", async () => {
    ctx = await testDb({ now: "2026-10-07T05:30:00Z" });
    await addLeads(ctx, 30); // демо записи в същата база
    await publishDailyBatch(ctx, { trigger: "demo" }); // днешният демо списък
    const parsed = parseBusinessFile(fixture(), "test.xlsx");
    // №30 вече има разговор в CRM; №31 е DNC
    const mk = async (i: number) =>
      (
        await tx(ctx.db, (t) =>
          ingestCandidate(t, { name: `ТЕСТ Бизнес ${i}`, city: "Варна", address: `ул. Тестова ${i}, 9000 Варна`, category: "auto", phone: `+35988900${1000 + i}`, source: "MANUAL", sourceUsageConfirmed: true, contactHistoryState: "NONE_CONFIRMED", verifiedAt: ctx.clock.now() }, ctx.clock.now()),
        )
      ).businessId;
    const h30 = await mk(30);
    await recordOutcome(ctx, { businessId: h30, outcome: "SPOKE", idempotencyKey: "fixture-30-spoke" } as never);
    const d31 = await mk(31);
    await ctx.db.suppression.create({ data: { type: "DNC", businessId: d31, reason: "тест" } });

    const rep = await importBusinessFile(ctx, parsed, { calledBefore: called, confirmOthersNotCalled: true, activateRealSource: true });
    expect(rep.read).toBe(70);
    expect(rep.matched).toBe(2);
    expect(rep.created).toBe(68);
    expect(rep.calledMarked).toBe(35);
    const prior = async (i: number) => (await ctx.db.business.findFirstOrThrow({ where: { sourceRowNo: i } })).priorContact;
    for (const [i, v] of [[20, "CALLED_BEFORE_IMPORT"], [21, "NOT_CALLED"], [50, "NOT_CALLED"], [51, "CALLED_BEFORE_IMPORT"], [65, "CALLED_BEFORE_IMPORT"], [66, "NOT_CALLED"]] as const) expect(await prior(i)).toBe(v);
    const calledRows = await ctx.db.business.findMany({ where: { priorContact: "CALLED_BEFORE_IMPORT" } });
    expect(calledRows).toHaveLength(35);
    expect(calledRows.every((b) => b.contactHistoryState === "HAS_HISTORY" && b.priorContactSource === "OWNER_CONFIRMATION" && b.lastContactAt === null && b.lastOutcome === null)).toBe(true);
    expect(await ctx.db.activity.count({ where: { business: { priorContact: "CALLED_BEFORE_IMPORT" } } })).toBe(0);
    // предимство: разговорът и DNC остават
    expect((await ctx.db.business.findUniqueOrThrow({ where: { id: h30 } })).pipelineStage).toBe("CONTACTED");
    expect(await ctx.db.suppression.count({ where: { businessId: d31, liftedAt: null } })).toBe(1);
    // „няма открит собствен сайт“ = наблюдение с доказателство, не категорично
    const b1 = await ctx.db.business.findFirstOrThrow({ where: { sourceRowNo: 22 } });
    expect(b1.websiteObservation).toBe("Няма открит собствен сайт");
    expect(b1.websiteStatus).toBe("NOT_FOUND_AFTER_CHECK");
    expect(b1.sourceCheckedOn).toBe("2026-10-01");
    expect(b1.importedAt).not.toBeNull();

    // повторен импорт
    const before = { b: await ctx.db.business.count(), i: await ctx.db.businessIdentifier.count(), a: await ctx.db.activity.count(), e: await ctx.db.sourceEvidence.count() };
    const rep2 = await importBusinessFile(ctx, parsed, { calledBefore: called, confirmOthersNotCalled: true });
    expect(rep2).toMatchObject({ created: 0, review: 0, historyWritten: 0, matched: 70 });
    expect({ b: await ctx.db.business.count(), i: await ctx.db.businessIdentifier.count(), a: await ctx.db.activity.count(), e: await ctx.db.sourceEvidence.count() }).toEqual(before);

    // днес: демо списъкът остава, без второ публикуване
    const again = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(again).toMatchObject({ created: false, added: 0, total: 25 });
    const q = await buildCallQueues(ctx.db, ctx.clock.now());
    expect(q.queues.new).toHaveLength(0); // днешният демо списък не влиза в опашките при реален източник

    // реални дневни списъци: 70 − 35 прозвънени − №30 − №31 = 33 допустими
    expect((await getSettings(ctx.db)).leadSource).toBe("REAL");
    const issued = new Set<string>();
    const sizes: number[] = [];
    // Работни дни (чт, пт, пн); преди всеки следващ списък активният се приключва (резултат за всеки контакт).
    for (const [i, day] of (["2026-10-08", "2026-10-09", "2026-10-12"] as const).entries()) {
      if (i > 0) {
        ctx.clock.set(zonedToUtc(addDays(day, -1), "17:00"));
        for (const id of issued) await recordOutcome(ctx, { businessId: id, outcome: "SPOKE", idempotencyKey: `fixture-done-${id}` } as never);
      }
      ctx.clock.set(zonedToUtc(day, "08:00"));
      const r = await publishDailyBatch(ctx, { localDate: day, trigger: "scheduler" });
      const items = await ctx.db.dailyBatchItem.findMany({ where: { batchId: r.batchId || "none" }, include: { business: true }, orderBy: { position: "asc" } });
      sizes.push(items.length);
      for (const it of items) {
        expect(issued.has(it.businessId)).toBe(false);
        issued.add(it.businessId);
        expect(it.business.isDemo).toBe(false);
        expect(it.business.priorContact).toBe("NOT_CALLED");
        expect([h30, d31]).not.toContain(it.businessId);
      }
      if (i === 0) {
        // A преди B; поне 3 категории в първия списък
        const pr = items.map((x) => x.business.callPriority).join("");
        expect(pr).toMatch(/^A+B*$/);
        expect(new Set(items.map((x) => x.business.category)).size).toBeGreaterThanOrEqual(3);
      }
      if (i === 1) expect(r.shortfallReason).toMatch(/Само 8 от 25/);
      if (i === 2) expect(r.blocked?.code).toBe("NO_CANDIDATES");
    }
    expect(sizes).toEqual([25, 8, 0]);
  });

  it("демо контролите са изключени при реален източник; смяната на настройката не трие нищо", async () => {
    ctx = await testDb();
    const s = await getSettings(ctx.db);
    await saveSettings(ctx.db, { ...s, leadSource: "REAL" });
    const { simulateNextDay } = await import("@/domain/demo");
    await expect(simulateNextDay(ctx)).rejects.toThrow(/реални/);
    // новите категории от файла са налични и разрешени
    expect((await getSettings(ctx.db)).categories.find((c) => c.key === "pets")?.enabled).toBe(true);
  });
});
