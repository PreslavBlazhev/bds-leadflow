import fs from "node:fs";
import path from "node:path";
import { run } from "./_ctx";

/**
 * npm run real:init — подготвя ОТДЕЛНАТА реална база:
 *  - създава .env.real от .env.real.example само ако липсва (никога не презаписва);
 *  - прилага миграциите към real базата (извън папката на проекта), БЕЗ seed;
 *  - проверява, че няма нито един demo/синтетичен запис.
 */
process.env.LEADFLOW_ENV_FILE = ".env.real";
run(async () => {
  const envPath = path.resolve(".env.real");
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.resolve(".env.real.example"), envPath, fs.constants.COPYFILE_EXCL);
    console.log("[real] Създаден .env.real от примера. Ключовете се попълват само там, локално.");
  } else console.log("[real] .env.real съществува — не се променя.");
  const { loadDotEnv } = await import("./_env");
  loadDotEnv(envPath);
  if (process.env.APP_MODE !== "real") throw new Error("Отказ: .env.real трябва да е с APP_MODE=real.");
  const { migrate } = await import("./db-migrate");
  await migrate();
  const { scriptCtx } = await import("./_ctx");
  const ctx = await scriptCtx("real-init");
  const demo = await ctx.db.business.count({ where: { OR: [{ isDemo: true }, { source: "DEMO" }, { phoneKind: "DEMO_SYNTHETIC" }] } });
  if (demo > 0) throw new Error(`Отказ: в real базата има ${demo} demo записа.`);
  // Докато няма активен източник, автоматичните дневни списъци са на пауза (без празни списъци и опити за известия).
  const { getSettings, saveSettings } = await import("../src/domain/settings");
  const s = await getSettings(ctx.db);
  if (!s.pauseNewLists && process.env.LIVE_DISCOVERY_ENABLED !== "true") {
    await saveSettings(ctx.db, { ...s, pauseNewLists: true });
    console.log("[real] Новите дневни списъци са на пауза до пускане на реален източник (Днес → „Възобнови“).");
  }
  const [biz, owners, pilots] = await Promise.all([ctx.db.business.count(), ctx.db.user.count(), ctx.db.pilotCandidate.count()]);
  const { sqliteFilePath } = await import("../src/lib/db");
  console.log(`[real] База: ${sqliteFilePath(ctx.env.DATABASE_URL)}`);
  console.log(`[real] Бизнеси: ${biz} (demo: 0) · пилотни кандидати: ${pilots} · owner: ${owners ? "да" : "не"}`);
  if (!owners) console.log("[real] Следва: npm run real:owner");
  await ctx.db.$disconnect();
});
