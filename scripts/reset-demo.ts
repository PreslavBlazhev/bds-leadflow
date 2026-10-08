import fs from "node:fs";
import readline from "node:readline";
import { scriptCtx, run } from "./_ctx";
import { sqliteFilePath } from "../src/lib/db";

/** Изтрива САМО demo базата след изрично потвърждение. Категорично отказва при real. */
run(async () => {
  const ctx = await scriptCtx("reset-demo");
  const meta = await ctx.db.systemMeta.findUnique({ where: { id: 1 } });
  if (ctx.mode !== "demo" || meta?.mode !== "demo") throw new Error("Отказ: reset-demo работи само с demo база.");
  // Реални записи (импорт, ръчни) не се трият с демо базата — първо backup/преместване.
  const real = await ctx.db.business.count({ where: { isDemo: false } });
  if (real > 0) throw new Error(`Отказ: в базата има ${real} реални (не-демо) записа. Направи npm run backup и ги премести, преди да нулираш.`);
  const file = sqliteFilePath(ctx.env.DATABASE_URL);
  if (!/demo/i.test(file)) throw new Error("Отказ: файлът не изглежда като demo база.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise<string>((r) => rl.question(`Ще бъде изтрита ${file}. Напиши RESET DEMO за потвърждение: `, r));
  rl.close();
  if (a.trim() !== "RESET DEMO") throw new Error("Отказано.");
  await ctx.db.$disconnect();
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) if (fs.existsSync(f)) fs.rmSync(f);
  console.log("Demo базата е изтрита. Изпълни npm run setup:demo и npm run owner:create.");
});
