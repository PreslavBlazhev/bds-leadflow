import { scriptCtx, run } from "./_ctx";
import { discoverPilot, historyCoverage, planPilot } from "../src/domain/pilot";
import { createPlacesClient, placesGate, SKU_DETAILS_ENTERPRISE, SKU_SEARCH_IDS } from "../src/providers/googlePlaces";
import { localDateOf } from "../src/lib/time";

/**
 * npm run pilot:discover            → ПЛАН (без мрежа, без заявки): какво би се търсило и колко заявки максимум.
 * npm run pilot:discover -- --run   → реално откриване (само real режим, ключ, потвърдени условия, LIVE_DISCOVERY_ENABLED).
 * Параметри: --limit=25 (одобрими кандидати), --max-details=60 (платими Place Details заявки), --city=Варна
 */
process.env.LEADFLOW_ENV_FILE = process.env.LEADFLOW_ENV_FILE || ".env.real";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
run(async () => {
  const limit = Math.min(25, Number(arg("limit") ?? 25));
  const maxEvaluations = Math.min(200, Number(arg("max-details") ?? 60));
  const cities = arg("city") ? [arg("city")!] : undefined;
  const ctx = await scriptCtx("pilot");
  const plan = planPilot({ limit, maxEvaluations });
  const cov = await historyCoverage(ctx.db);
  const month = localDateOf(ctx.clock.now()).slice(0, 7);
  const usage = await ctx.db.apiUsage.findMany({ where: { month } });
  const used = (sku: string) => usage.find((u) => u.sku === sku)?.count ?? 0;
  console.log(`Режим: ${ctx.mode} · база: отделна (${ctx.env.DATABASE_URL})`);
  console.log(`Стара история: импортирани ${cov.imported} записа, с история ${cov.withHistory}.${cov.imported === 0 ? " ВНИМАНИЕ: не е импортирана — „никога не съм звънял“ НЕ може да се гарантира." : ""}`);
  console.log(`Лимити този месец: Text Search (само ID) ${used(SKU_SEARCH_IDS)}/${ctx.env.PLACES_MAX_SEARCH_PER_MONTH}, Place Details Enterprise ${used(SKU_DETAILS_ENTERPRISE)}/${ctx.env.PLACES_MAX_DETAILS_PER_MONTH}`);
  console.log(`План: ${plan.queries.length} търсения (град × тип), до ${plan.maxSearchRequests} страници; до ${plan.maxDetailsRequests} Place Details.`);
  for (const n of plan.notes) console.log(`  • ${n}`);
  if (!process.argv.includes("--run")) {
    const gate = placesGate(ctx.env);
    console.log(`\nТова е само план — няма заявки. Готовност за --run: ${gate.ok ? "ДА" : `НЕ — ${gate.reason}`}`);
    await ctx.db.$disconnect();
    return;
  }
  const client = createPlacesClient(ctx.db, ctx.env, () => ctx.clock.now());
  const r = await discoverPilot(ctx, client, { limit, maxEvaluations, cities });
  console.log(`\nРезултат: за преглед ${r.pending}, в моята история/DNC ${r.inHistory}, пропуснати (без телефон/затворени) ${r.skipped}, вече виждани ${r.alreadyKnown}.`);
  console.log(`Заявки: Text Search ${r.searchRequests} (безплатни), Place Details ${r.detailsRequests}. Спря: ${r.stoppedBy}.`);
  console.log("Следва: отвори /pilot и прегледай кандидатите ръчно преди обаждания.");
  await ctx.db.$disconnect();
});
