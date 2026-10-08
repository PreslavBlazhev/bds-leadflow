import { loadDotEnv } from "./_env";
import { appClock, assertDbMode, createDb, type Ctx } from "../src/lib/db";
import { getEnv } from "../src/lib/env";

export async function scriptCtx(actor = "cli"): Promise<Ctx & { env: ReturnType<typeof getEnv> }> {
  loadDotEnv();
  const env = getEnv();
  const db = await createDb(env.DATABASE_URL);
  await assertDbMode(db, env.APP_MODE);
  return { db, mode: env.APP_MODE, clock: await appClock(db, env.APP_MODE), actor, env };
}

export function run(fn: () => Promise<void>) {
  fn().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
