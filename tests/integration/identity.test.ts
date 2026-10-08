import { afterEach, describe, expect, it } from "vitest";
import { publishDailyBatch } from "@/domain/batch";
import { commitImport } from "@/domain/csv";
import { archiveLead, editLead, mergeBusinesses } from "@/domain/crm";
import { buildEligibilityCtx, candidateInclude, evaluateEligibility, type CandidateRow } from "@/domain/eligibility";
import { recordOutcome } from "@/domain/outcomes";
import { getSettings } from "@/domain/settings";
import { tx } from "@/lib/db";
import { ingestCandidate } from "@/domain/ingest";
import { addLead, addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

async function eligibility(c: TestCtx, id: string) {
  const s = await getSettings(c.db);
  const e = await buildEligibilityCtx(c.db, c.mode, s, c.clock.now());
  const b = (await c.db.business.findUniqueOrThrow({ where: { id }, include: candidateInclude })) as CandidateRow;
  return evaluateEligibility(b, e);
}

const csv = (rows: string[][]) => ["Business Name,Business Type,City,Phone,Website,contacted_before,Last Contact,Stage", ...rows.map((r) => r.map((x) => `"${x}"`).join(","))].join("\n");

describe("identity и никакви повторни нови", () => {
  it("T07 смяна на име/телефон при известни aliases не изчиства историята и не прави записа нов", async () => {
    ctx = await testDb();
    const { businessId } = await addLead(ctx, { name: "ТЕСТ Пицария Алфа", phone: "+359 88 111 2222" });
    await recordOutcome(ctx, { businessId, outcome: "NO_ANSWER", idempotencyKey: "idem-t07-1-key" });
    await editLead(ctx, businessId, { name: "ТЕСТ Пицария Алфа Нова", phone: "0889999999" });
    const ids = await ctx.db.businessIdentifier.findMany({ where: { businessId, type: "PHONE" } });
    expect(ids.map((i) => i.value).sort()).toEqual(["+359881112222", "+359889999999"]);
    expect(await ctx.db.activity.count({ where: { businessId } })).toBe(1);
    expect((await eligibility(ctx, businessId)).eligible).toBe(false);
    // нов запис със СТАРИЯ телефон и старото име → разпознат като същия бизнес
    const again = await tx(ctx.db, (t) => ingestCandidate(t, { name: "ТЕСТ Пицария Алфа Нова", city: "Варна", category: "restaurant", phone: "00359881112222", source: "CSV", sourceUsageConfirmed: true, contactHistoryState: "NONE_CONFIRMED" }, ctx.clock.now()));
    expect(again).toMatchObject({ kind: "existing", businessId });
  });

  it("T08 reimport на архивиран, контактуван или DNC запис не го прави нов", async () => {
    ctx = await testDb();
    const a = await addLead(ctx, { name: "ТЕСТ Архив", phone: "0881000001" });
    const c = await addLead(ctx, { name: "ТЕСТ Контакт", phone: "0881000002" });
    const d = await addLead(ctx, { name: "ТЕСТ DNC", phone: "0881000003" });
    await archiveLead(ctx, a.businessId, "тест");
    await recordOutcome(ctx, { businessId: c.businessId, outcome: "SPOKE", idempotencyKey: "idem-t08-c-key" });
    await recordOutcome(ctx, { businessId: d.businessId, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "idem-t08-d-key" });
    const text = csv([
      ["ТЕСТ Архив", "Пицария", "Варна", "+359881000001", "", "no", "", ""],
      ["ТЕСТ Контакт", "Пицария", "Варна", "00359881000002", "", "no", "", ""],
      ["ТЕСТ DNC", "Пицария", "Варна", "088 100 0003", "", "no", "", ""],
    ]);
    const r = await commitImport(ctx, { filename: "re.csv", text, usageConfirmed: true, confirmNeverContacted: true });
    expect(r.counts).toMatchObject({ created: 0, duplicate: 3 });
    expect(await ctx.db.business.count()).toBe(3);
    const dncBiz = await ctx.db.business.findUniqueOrThrow({ where: { id: d.businessId }, include: { suppressions: { where: { liftedAt: null } } } });
    expect(dncBiz.suppressions.some((s) => s.type === "DNC")).toBe(true);
    for (const id of [a.businessId, c.businessId, d.businessId]) expect((await eligibility(ctx, id)).eligible).toBe(false);
    // повторен импорт на същия файл: нищо ново
    const r2 = await commitImport(ctx, { filename: "re.csv", text, usageConfirmed: true, confirmNeverContacted: true });
    expect(r2.counts.created).toBe(0);
    expect(await ctx.db.activity.count({ where: { type: "IMPORTED_HISTORY" } })).toBe(0);
  });

  it("T09 общ телефон/домейн (клонове) и social домейн не водят до сляпо сливане; конфликтите са извън новите", async () => {
    ctx = await testDb();
    const main = await addLead(ctx, { name: "ТЕСТ Сервиз Център", phone: "0882000001", website: "https://servis-test.bg" });
    const branch = await addLead(ctx, { name: "ТЕСТ Сервиз Клон Изток", phone: "0882000001" });
    expect(branch.kind).toBe("created");
    expect(branch.kind === "created" && branch.review).toBe(true);
    const site = await addLead(ctx, { name: "ТЕСТ Друг Бизнес", phone: "0882000099", website: "http://www.servis-test.bg/" });
    expect(site.kind === "created" && site.review).toBe(true);
    // facebook.com не е идентификатор → два различни бизнеса без конфликт
    const fb1 = await addLead(ctx, { name: "ТЕСТ FB Едно", phone: "0882000011", website: "https://facebook.com/fb.one" });
    const fb2 = await addLead(ctx, { name: "ТЕСТ FB Две", phone: "0882000012", website: "https://www.facebook.com/fb.two" });
    expect(fb1.kind === "created" && fb1.review).toBe(false);
    expect(fb2.kind === "created" && fb2.review).toBe(false);
    expect(await ctx.db.business.count({ where: { mergedIntoId: { not: null } } })).toBe(0);
    expect((await eligibility(ctx, branch.businessId)).eligible).toBe(false);
    expect((await eligibility(ctx, main.businessId)).eligible).toBe(true);
    // ако основният е контактуван, непровереният клон остава изключен дори след „различни бизнеси“
    await recordOutcome(ctx, { businessId: main.businessId, outcome: "SPOKE", idempotencyKey: "idem-t09-key" });
    await ctx.db.business.update({ where: { id: branch.businessId }, data: { reviewStatus: "NONE" } });
    const el = await eligibility(ctx, branch.businessId);
    expect(el.eligible).toBe(false);
    expect(el.reasons.join(" ")).toMatch(/Споделен/);
  });

  it("T10 merge пази най-ранните issued/contact дати, aliases, дейности и най-строгото потискане", async () => {
    ctx = await testDb();
    const keep = await addLead(ctx, { name: "ТЕСТ Слят Основен", phone: "0883000001" });
    const other = await addLead(ctx, { name: "ТЕСТ Слят Дубликат", phone: "0883000002", website: "https://slyat-test.bg" });
    await addLeads(ctx, 30);
    await ctx.db.business.update({ where: { id: other.businessId }, data: { firstIssuedAt: new Date("2026-09-01T06:00:00Z") } });
    await recordOutcome(ctx, { businessId: other.businessId, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "idem-t10-key" });
    await mergeBusinesses(ctx, keep.businessId, other.businessId, "тест");
    const k = await ctx.db.business.findUniqueOrThrow({ where: { id: keep.businessId }, include: { identifiers: true, activities: true, suppressions: { where: { liftedAt: null } } } });
    expect(k.firstIssuedAt?.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    expect(k.contactHistoryState).toBe("HAS_HISTORY");
    expect(k.identifiers.map((i) => i.value)).toEqual(expect.arrayContaining(["+359883000001", "+359883000002", "slyat-test.bg"]));
    expect(k.activities).toHaveLength(1);
    expect(k.suppressions.some((s) => s.type === "DNC")).toBe(true);
    const m = await ctx.db.business.findUniqueOrThrow({ where: { id: other.businessId } });
    expect(m.mergedIntoId).toBe(keep.businessId);
    await publishDailyBatch(ctx, { trigger: "manual" });
    expect(await ctx.db.dailyBatchItem.count({ where: { businessId: { in: [keep.businessId, other.businessId] } } })).toBe(0);
    expect(await ctx.db.auditLog.count({ where: { action: "lead.merge" } })).toBe(1);
  });

  it("T11 неизвестна история при импорт е извън новите; изричното потвърждение се записва в audit", async () => {
    ctx = await testDb();
    const text = csv([
      ["ТЕСТ Импорт Едно", "Пицария", "Варна", "0884000001", "", "", "", ""],
      ["ТЕСТ Импорт Две", "Автосервиз", "Плевен", "0884000002", "", "yes", "12.09.2026", "CONTACTED"],
    ]);
    const r = await commitImport(ctx, { filename: "old.csv", text, usageConfirmed: true });
    expect(r.counts.created).toBe(2);
    const rows = await ctx.db.business.findMany({ orderBy: { ref: "asc" } });
    expect(rows.map((b) => b.contactHistoryState)).toEqual(["UNKNOWN", "HAS_HISTORY"]);
    for (const b of rows) expect((await eligibility(ctx, b.id)).eligible).toBe(false);
    expect(await ctx.db.activity.count({ where: { type: "IMPORTED_HISTORY" } })).toBe(1);
    const pub = await publishDailyBatch(ctx, { trigger: "manual" });
    expect(pub.total).toBe(0);
    await commitImport(ctx, { filename: "new.csv", text: csv([["ТЕСТ Импорт Три", "Салон", "Варна", "0884000003", "", "", "", ""]]), usageConfirmed: true, confirmNeverContacted: true });
    const audit = await ctx.db.auditLog.findFirst({ where: { action: "import.commit", details: { contains: '"confirmNeverContacted":true' } } });
    expect(audit).not.toBeNull();
  });
});
