import path from "node:path";
import { scriptCtx, run } from "./_ctx";
import { backupDb, verifyBackup } from "../src/domain/backup";

/** npm run backup — VACUUM INTO в backups/ (извън Git) + проверка чрез възстановяване във временна база. */
run(async () => {
  const ctx = await scriptCtx("backup");
  const file = await backupDb(ctx.db, ctx.mode);
  console.log(`[backup] ${path.relative(process.cwd(), file)}`);
  const v = await verifyBackup(ctx.db, file);
  console.log(`[backup] Проверка на възстановяване във временна база: ${v.ok ? "OK" : "РАЗЛИКИ: " + v.mismatches.join(", ")}`);
  console.log(`[backup] Totals: ${JSON.stringify(v.restored)}`);
  await ctx.db.$disconnect();
  if (!v.ok) process.exit(2);
});
