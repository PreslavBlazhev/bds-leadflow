import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { migrate } from "../../scripts/db-migrate";
import { scriptCtx } from "../../scripts/_ctx";
import { seedDemo } from "../../src/domain/seed";
import { publishDailyBatch } from "../../src/domain/batch";
import { hashPassword } from "../../src/lib/auth";

/** Свежа e2e база (никога demo.db/real.db) + owner със случайна парола, записана само в tests/.tmp (gitignored). */
async function main() {
  if (!/e2e-test\.db/.test(process.env.DATABASE_URL ?? "")) throw new Error("E2E изисква DATABASE_URL към e2e-test.db");
  const file = path.resolve("data/e2e-test.db");
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) if (fs.existsSync(f)) fs.rmSync(f);
  await migrate();
  const ctx = await scriptCtx("e2e");
  await seedDemo(ctx);
  await publishDailyBatch(ctx, { trigger: "demo" });
  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  await ctx.db.user.create({ data: { username: "owner", passwordHash: await hashPassword(password) } });
  fs.mkdirSync("tests/.tmp", { recursive: true });
  fs.writeFileSync("tests/.tmp/e2e-owner.json", JSON.stringify({ username: "owner", password }));
  await ctx.db.$disconnect();
  console.log("[e2e] база и owner са готови");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
