import fs from "node:fs";
import path from "node:path";
import { scriptCtx, run } from "./_ctx";
import { backupDb, verifyBackup } from "../src/domain/backup";
import { realStockSummary } from "../src/domain/realStock";
import { importBusinessFile, parseBusinessFile, parseRanges, type ImportReport } from "../src/domain/xlsxImport";
import { sqliteFilePath } from "../src/lib/db";

/**
 * npm run import:xlsx -- [--file=<път>] [--called=1-20,51-65] [--commit] [--activate-real] [--report=<json>]
 * По подразбиране: само преглед (транзакцията се връща, нищо не се записва).
 * --commit: първо проверен backup (VACUUM INTO + възстановяване във временна база), после атомарен импорт.
 * --called: „Пореден номер“ на бизнесите, на които собственикът потвърждава, че е звънял; останалите от листа
 *           се записват като „още не е звъняно“ (потвърждение от собственика).
 */
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = (k: string) => process.argv.includes(`--${k}`);

export function printReport(rep: ImportReport) {
  console.log(`[import] Файл: ${rep.fileName} · лист „${rep.sheet}“ · sha256 ${rep.contentHash.slice(0, 16)}…`);
  console.log(`[import] ${rep.dryRun ? "ПРЕГЛЕД (нищо не е записано)" : "ЗАПИСАНО"}: прочетени ${rep.read} · нови ${rep.created} · съпоставени със съществуващи ${rep.matched} · за проверка (възможен дубликат) ${rep.review} · пропуснати ${rep.skipped}`);
  console.log(`[import] История: прозвънени преди импорта ${rep.calledMarked} · „още не е звъняно“ ${rep.notCalledMarked} · нови исторически отметки ${rep.historyWritten}`);
  for (const r of rep.rows.filter((x) => x.action === "review" || x.action === "skipped" || x.kept)) console.log(`  №${r.seq} ${r.name}: ${r.action}${r.kept ? ` · запазено: ${r.kept}` : ""}${r.message ? ` · ${r.message}` : ""}`);
  if (rep.issues.length) {
    console.log(`[import] Бележки по данните (${rep.issues.length}):`);
    for (const i of rep.issues) console.log(`  ${i.seq ? `№${i.seq}` : `ред ${i.physicalRow}`}: ${i.message}`);
  }
}

run(async () => {
  const file = path.resolve(arg("file") ?? path.join(process.env.USERPROFILE ?? "", "Desktop", "biznesi_varna_bez_sait.xlsx"));
  if (!fs.existsSync(file)) throw new Error(`Файлът не съществува: ${file}`);
  const called = parseRanges(arg("called") ?? "");
  const commit = flag("commit");
  const ctx = await scriptCtx("import-xlsx");
  const parsed = parseBusinessFile(fs.readFileSync(file), path.basename(file));
  console.log(`[import] База: ${sqliteFilePath(ctx.env.DATABASE_URL)} (режим ${ctx.mode})`);
  console.log(`[import] Листове: ${Object.entries(parsed.sheetCounts).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.log(`[import] Връзки от формули: ${parsed.linkStats.extracted}/${parsed.linkStats.formulas} (от тях _LONGTEXT: ${parsed.linkStats.longText})`);

  let backup: string | null = null;
  if (commit) {
    backup = await backupDb(ctx.db, ctx.mode);
    const v = await verifyBackup(ctx.db, backup);
    console.log(`[import] Backup: ${backup} · проверка чрез възстановяване: ${v.ok ? "OK" : "РАЗЛИКИ " + v.mismatches.join(",")}`);
    if (!v.ok) throw new Error("Backup-ът не мина проверката — импортът е спрян.");
  }
  const rep = await importBusinessFile(ctx, parsed, { calledBefore: called, confirmOthersNotCalled: true, activateRealSource: flag("activate-real"), dryRun: !commit });
  printReport(rep);

  const stock = await realStockSummary(ctx.db, ctx.mode, ctx.clock.now());
  console.log(`[import] Източник на новите списъци: ${stock.leadSource}${stock.leadSource === "REAL" ? "" : " (реалните записи влизат в списъците след --activate-real)"}`);
  console.log(`[import] Допустими реални кандидати сега: ${stock.eligible} · по приоритет ${JSON.stringify(stock.byPriority)}`);
  const out = arg("report");
  if (out) fs.writeFileSync(out, JSON.stringify({ backup, report: rep, stock: { ...stock, preview: stock.preview?.items.map((i) => i.ref) } }, null, 2));
  await ctx.db.$disconnect();
});
