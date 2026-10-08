import fs from "node:fs";
import path from "node:path";
import { run } from "./_ctx";

/**
 * npm run setup:demo — създава .env САМО ако липсва (от .env.example, demo режим),
 * прилага миграциите, idempotent seed и днешния списък (само веднъж). Не презаписва .env или DB.
 */
run(async () => {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) {
    let tpl = fs.readFileSync(path.resolve(".env.example"), "utf8");
    // Локални VAPID ключове за тест на абонамента в браузъра (в demo доставките остават previews).
    const webpush = (await import("web-push")).default;
    const keys = webpush.generateVAPIDKeys();
    tpl = tpl
      .replace(/^NEXT_PUBLIC_VAPID_PUBLIC_KEY=.*$/m, `NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`)
      .replace(/^VAPID_PRIVATE_KEY=.*$/m, `VAPID_PRIVATE_KEY=${keys.privateKey}`)
      .replace(/^VAPID_SUBJECT=.*$/m, "VAPID_SUBJECT=mailto:owner@example.invalid");
    fs.writeFileSync(envPath, tpl, { encoding: "utf8", flag: "wx" });
    console.log("[setup] Създаден .env (demo). Съществуващ .env никога не се презаписва.");
  } else {
    console.log("[setup] .env съществува — не се променя.");
  }
  const { loadDotEnv } = await import("./_env");
  loadDotEnv();
  if (process.env.APP_MODE !== "demo") throw new Error("Отказ: setup:demo изисква APP_MODE=demo в .env.");
  const { migrate } = await import("./db-migrate");
  await migrate();
  const { scriptCtx } = await import("./_ctx");
  const ctx = await scriptCtx("setup");
  const { seedDemo } = await import("../src/domain/seed");
  await seedDemo(ctx, { log: (s) => console.log(`[seed] ${s}`) });
  const { publishDailyBatch } = await import("../src/domain/batch");
  const r = await publishDailyBatch(ctx, { trigger: "demo" });
  console.log(`[setup] Днешен списък ${r.localDate}: ${r.total}/${r.target} (${r.created ? "създаден" : "вече съществува"}).`);
  const owner = await ctx.db.user.count();
  console.log(owner ? "[setup] Owner акаунт съществува." : "[setup] Следваща стъпка: npm run owner:create");
  await ctx.db.$disconnect();
});
