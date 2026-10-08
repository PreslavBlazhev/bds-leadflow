import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "./_env";
import { run } from "./_ctx";
import { createDb, sqliteFilePath, type Ctx } from "../src/lib/db";
import { getEnv } from "../src/lib/env";
import { addDays, fixedClock, localDateOf, weekdayOf, zonedToUtc } from "../src/lib/time";
import { backupDb } from "../src/domain/backup";
import { publishDailyBatch } from "../src/domain/batch";
import { buildCallQueues } from "../src/domain/callQueue";
import { normalizePhone } from "../src/domain/identity";
import { recordOutcome } from "../src/domain/outcomes";
import { realStockSummary } from "../src/domain/realStock";
import { importBusinessFile, parseBusinessFile, parseRanges } from "../src/domain/xlsxImport";

/**
 * Проверка на импорта върху ОТДЕЛНА тестова база: копие (VACUUM INTO) на работната база във временна папка,
 * миграции, предварителни случаи за предимство (история, DNC, издаден), импорт, повторен импорт и
 * симулирани дневни списъци до изчерпване. Работната база не се променя. Копието се изтрива накрая.
 * npm run import:xlsx:verify -- [--file=<път>] [--called=1-20,51-65]
 */
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

run(async () => {
  loadDotEnv();
  const env = getEnv();
  const file = path.resolve(arg("file") ?? path.join(process.env.USERPROFILE ?? "", "Desktop", "biznesi_varna_bez_sait.xlsx"));
  const calledSpec = arg("called") ?? "1-20,51-65";
  const called = parseRanges(calledSpec);
  const parsed = parseBusinessFile(fs.readFileSync(file), path.basename(file));

  const work = await createDb(env.DATABASE_URL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-xlsx-verify-"));
  const copy = await backupDb(work, "verify", dir);
  await work.$disconnect();
  const prismaBin = path.resolve("node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prismaBin, "migrate", "deploy"], { stdio: "ignore", env: { ...process.env, DATABASE_URL: `file:${copy}` } });
  const db = await createDb(`file:${copy.replace(/\\/g, "/")}`);
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  try {
    const realNow = new Date();
    const clock = fixedClock(realNow);
    const ctx: Ctx = { db, mode: env.APP_MODE, clock, actor: "verify" };
    const today = localDateOf(realNow);
    const todayBatchBefore = await db.dailyBatch.findUnique({ where: { localDate: today }, include: { items: { select: { businessId: true } } } });
    const demoCountBefore = await db.business.count({ where: { isDemo: true } });

    // 0) Бройки по листове
    const sc = parsed.sheetCounts;
    check("Бройки в листовете", sc["Основен списък"] === 216 && sc["Без публикуван телефон"] === 19 && sc["За допълнителна проверка"] === 577 && (sc["Неработещи сайтове"] ?? 0) === 0, JSON.stringify(sc));

    // 1) Предварителни случаи за предимство (само в тестовата база): №100 — съществуваща история с разговор, №101 — DNC, №102 — вече издаден.
    const pick = (seq: number) => parsed.rows.find((r) => r.seq === seq)!;
    const mk = async (seq: number, extra: (id: string) => Promise<void>) => {
      const r = pick(seq);
      const { ingestCandidate } = await import("../src/domain/ingest");
      const b = await db.$transaction((t) =>
        ingestCandidate(t, { name: r.name, city: "Варна", address: r.address, category: r.category ?? "auto", phone: r.phone, source: "MANUAL", sourceUsageConfirmed: true, contactHistoryState: "NONE_CONFIRMED", verifiedAt: realNow }, realNow),
      );
      await extra(b.businessId);
      return b.businessId;
    };
    const histId = await mk(100, async (id) => {
      await recordOutcome(ctx, { businessId: id, outcome: "SPOKE", note: "тест: съществуващ разговор", idempotencyKey: "verify-hist-100" } as never);
    });
    const dncId = await mk(101, async (id) => {
      await db.suppression.create({ data: { type: "DNC", businessId: id, reason: "тест: DNC преди импорта" } });
      await db.suppression.create({ data: { type: "DNC", identifierType: "PHONE", identifierValue: normalizePhone(pick(101).phone)!.normalized!, reason: "тест" } });
    });
    const issuedId = await mk(102, async (id) => {
      await db.business.update({ where: { id }, data: { firstIssuedAt: zonedToUtc(addDays(today, -3), "08:00") } });
    });
    const histBefore = await db.activity.count({ where: { businessId: histId } });

    // 2) Импорт
    const rep = await importBusinessFile(ctx, parsed, { calledBefore: called, confirmOthersNotCalled: true, activateRealSource: true });
    check("Прочетени 216 реда", rep.read === 216, `нови ${rep.created}, съпоставени ${rep.matched}, проверка ${rep.review}, пропуснати ${rep.skipped}`);
    const calledRows = await db.business.findMany({ where: { priorContact: "CALLED_BEFORE_IMPORT" }, select: { sourceRowNo: true, contactHistoryState: true, priorContactSource: true } });
    const calledSeqs = calledRows.map((b) => b.sourceRowNo!).sort((a, b) => a - b);
    check("Точно 35 разпознати като прозвънени", calledRows.length === 35 && calledSeqs.join(",") === [...called].sort((a, b) => a - b).join(","), calledSeqs.join(","));
    check("Историята е от собственика, без дата/резултат", calledRows.every((b) => b.contactHistoryState === "HAS_HISTORY" && b.priorContactSource === "OWNER_CONFIRMATION"));
    const calledActs = await db.activity.count({ where: { business: { priorContact: "CALLED_BEFORE_IMPORT", source: "XLSX" } } });
    check("Без измислени обаждания/резултати за прозвънените", calledActs === 0, `дейности: ${calledActs}`);
    const bySeq = async (n: number) => db.business.findFirst({ where: { sourceName: parsed.fileName, sourceRowNo: n }, select: { priorContact: true } });
    const exp: Record<number, string> = { 20: "CALLED_BEFORE_IMPORT", 21: "NOT_CALLED", 50: "NOT_CALLED", 51: "CALLED_BEFORE_IMPORT", 65: "CALLED_BEFORE_IMPORT", 66: "NOT_CALLED" };
    const bound = await Promise.all(Object.keys(exp).map(async (k) => [k, (await bySeq(Number(k)))?.priorContact] as const));
    check("Гранични номера 20/21/50/51/65/66", bound.every(([k, v]) => v === exp[Number(k)]), bound.map(([k, v]) => `${k}:${v}`).join(" "));
    check("181 отбелязани „още не е звъняно“", (await db.business.count({ where: { priorContact: "NOT_CALLED" } })) === 181);

    // Предимство
    const h = await db.business.findUniqueOrThrow({ where: { id: histId } });
    check("Съществуваща история се запазва", h.pipelineStage !== "NEW" && (await db.activity.count({ where: { businessId: histId } })) === histBefore && h.priorContact === "NOT_CALLED", `етап ${h.pipelineStage}`);
    const d = await db.suppression.count({ where: { businessId: dncId, type: "DNC", liftedAt: null } });
    check("DNC се запазва", d === 1);
    const iss = await db.business.findUniqueOrThrow({ where: { id: issuedId } });
    check("Вече издаден остава издаден", !!iss.firstIssuedAt);

    // URL адреси
    const xl = await db.business.findMany({ where: { source: "XLSX" }, select: { mapsUrl: true, facebookUrl: true, instagramUrl: true, otherProfileUrl: true, sourceRowNo: true } });
    const all = await db.business.findMany({ where: { sourceName: parsed.fileName }, select: { mapsUrl: true, facebookUrl: true, instagramUrl: true, otherProfileUrl: true, sourceRowNo: true } });
    const maps = all.filter((b) => b.mapsUrl?.startsWith("https://www.google.com/maps/place/"));
    const longOnes = parsed.rows.filter((r) => (r.mapsUrl?.length ?? 0) > 255);
    const shortOnes = parsed.rows.filter((r) => (r.mapsUrl?.length ?? 0) <= 255);
    const r2 = pick(2);
    check(
      "Истински URL адреси (кратки и дълги/_LONGTEXT)",
      maps.length === 216 &&
        all.every((b) => !/^(Google Maps|Facebook|Instagram|Профил)$/.test(b.mapsUrl ?? "")) &&
        parsed.rows.every((r) => !r.mapsUrl?.includes('","')) &&
        r2.mapsUrl!.length > 255 && /!19sChIJ[A-Za-z0-9_-]{10,}/.test(r2.mapsUrl!) &&
        /16s%2Fg%2F[a-z0-9]+/.test(r2.mapsUrl!),
      `maps ${maps.length}, FB ${all.filter((b) => b.facebookUrl).length}, IG ${all.filter((b) => b.instagramUrl).length}, други ${all.filter((b) => b.otherProfileUrl).length}; дълги ${longOnes.length}, кратки ${shortOnes.length}; XLSX записи ${xl.length}`,
    );

    // 3) Повторен импорт
    const counts = async () => ({ biz: await db.business.count(), ids: await db.businessIdentifier.count(), acts: await db.activity.count(), ev: await db.sourceEvidence.count(), aud: await db.websiteAudit.count(), dup: await db.duplicateCandidate.count() });
    const c1 = await counts();
    const rep2 = await importBusinessFile(ctx, parsed, { calledBefore: called, confirmOthersNotCalled: true, activateRealSource: true });
    const c2 = await counts();
    check("Повторен импорт: 0 нови записа и 0 нови исторически отметки", rep2.created === 0 && rep2.review === 0 && rep2.historyWritten === 0 && JSON.stringify(c1) === JSON.stringify(c2), `съпоставени ${rep2.matched}; ${JSON.stringify(c2)}`);

    // 4) Днес: без второ публикуване; демо историята е запазена
    const pubToday = await publishDailyBatch(ctx, { trigger: "manual" });
    const todayAfter = await db.dailyBatch.findUnique({ where: { localDate: today }, include: { items: { select: { businessId: true } } } });
    check(
      "Днешният (демо) списък е запазен, без второ публикуване",
      !!todayBatchBefore && pubToday.created === false && pubToday.added === 0 && todayAfter!.items.length === todayBatchBefore.items.length,
      `днес ${todayAfter?.items.length}/${todayAfter?.target}`,
    );
    check("Демо записите не са изтрити", (await db.business.count({ where: { isDemo: true } })) === demoCountBefore);
    const q = await buildCallQueues(db, realNow);
    const qIds = [...q.queues.new, ...q.queues.followups, ...q.queues.backlog].map((e) => e.businessId);
    const qDemo = await db.business.count({ where: { id: { in: qIds }, isDemo: true } });
    check("Опашките за обаждания не съдържат демо контакти", qDemo === 0, `в опашките: ${qIds.length}`);

    const stock = await realStockSummary(db, ctx.mode, realNow);
    console.log(`INFO запас: ${stock.eligible} допустими; първи реален списък ${stock.firstDate} ${stock.publishTime}; планирани дни ${stock.plannedDays.map((x) => `${x.localDate}:${x.count}`).join(" ")}; остаряват неизползвани ${stock.staleUnused}`);
    const firstPreview = stock.preview?.items ?? [];

    // 5) Симулирани дневни списъци до изчерпване
    const seen = new Set<string>();
    let repeats = 0;
    let demoIn = 0;
    let bad = 0;
    let short: string | null = null;
    const perDay: string[] = [];
    let firstMatchesPreview = false;
    for (let i = 1; i <= 21; i++) {
      const day = addDays(today, i);
      if (weekdayOf(day) > 5) continue; // нови списъци само пн–пт
      // активният списък трябва да е приключен (резултат за всеки) преди следващия
      clock.set(zonedToUtc(addDays(day, -1), "18:00"));
      for (const id of seen) await recordOutcome(ctx, { businessId: id, outcome: "SPOKE", idempotencyKey: `verify-done-${id}` } as never);
      clock.set(zonedToUtc(day, "08:00"));
      const r = await publishDailyBatch(ctx, { localDate: day, trigger: "scheduler" });
      const items = await db.dailyBatchItem.findMany({ where: { batchId: r.batchId || "none" }, include: { business: { select: { isDemo: true, priorContact: true, id: true, callPriority: true, category: true } } } });
      if (i === 1) firstMatchesPreview = items.map((x) => x.businessId).join(",") === firstPreview.map((x) => x.id).join(",");
      for (const it of items) {
        if (seen.has(it.businessId)) repeats++;
        seen.add(it.businessId);
        if (it.business.isDemo) demoIn++;
        if (it.business.priorContact === "CALLED_BEFORE_IMPORT" || [histId, dncId, issuedId].includes(it.businessId)) bad++;
      }
      const cats = new Set(items.map((x) => x.business.category)).size;
      const a = items.filter((x) => x.business.callPriority === "A").length;
      perDay.push(`${day}:${items.length}(A${a},кат.${cats})`);
      if (items.length < 25 && !short) short = `${day}: ${items.length} — ${r.shortfallReason ?? r.blocked?.reason ?? ""}`;
      if (items.length === 0) break;
    }
    console.log(`INFO списъци: ${perDay.join(" ")}`);
    check("Първият реален списък съвпада с прегледа", firstMatchesPreview, `${firstPreview.length} в прегледа`);
    check("Дневните списъци не повтарят бизнеси", repeats === 0, `уникални издадени ${seen.size}`);
    check("Реалните списъци не съдържат демо контакти", demoIn === 0);
    check("Прозвънени/история/DNC/издадени никога не влизат в нов списък", bad === 0);
    check("При изчерпан/недостатъчен запас: действителна бройка или ясна причина, без допълване", !!short && /Само \d+ от 25|Няма допустими нови кандидати/.test(short), short ?? "");
  } finally {
    await db.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nРЕЗУЛТАТ: ${results.length - failed.length}/${results.length} PASS (тестова база: копие на ${path.basename(sqliteFilePath(env.DATABASE_URL))}, изтрито след проверката)`);
  if (failed.length) process.exit(2);
});
