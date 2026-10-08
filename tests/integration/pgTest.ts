import { randomBytes } from "node:crypto";
import { clientCtor } from "@/lib/prismaClients";

/**
 * PostgreSQL за интеграционните тестове: LF_TEST_PG_URL = admin адрес към DISPOSABLE сървър
 * (локално: npm run pg:local -- start; CI: postgres service). Всеки тест получава СОБСТВЕНА база,
 * копирана от мигрирания template; след теста базата се изтрива.
 * Защити: само localhost (освен LF_TEST_PG_ALLOW_REMOTE=1 в CI), имената на базите съдържат "test".
 */
export const PG_ADMIN_URL = process.env.LF_TEST_PG_URL ?? "";
export const isPgTest = PG_ADMIN_URL !== "";

export function assertSafePgTestUrl(url = PG_ADMIN_URL) {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) && process.env.LF_TEST_PG_ALLOW_REMOTE !== "1") {
    throw new Error("LF_TEST_PG_URL трябва да е локален disposable сървър (127.0.0.1/localhost).");
  }
}

export const dbUrl = (name: string) => {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

export const templateName = () => process.env.LF_PG_TEMPLATE ?? "lf_template_test";

async function admin() {
  assertSafePgTestUrl();
  const Ctor = clientCtor("postgresql");
  return new Ctor({ datasourceUrl: `${PG_ADMIN_URL}${PG_ADMIN_URL.includes("?") ? "&" : "?"}connection_limit=1`, log: ["error"] });
}

export async function adminExec(sql: string) {
  const db = await admin();
  try {
    for (let i = 0; ; i++) {
      try {
        return await db.$executeRawUnsafe(sql);
      } catch (e) {
        // Конкурентно копиране от същия template → кратко изчакване и нов опит.
        if (i < 20 && /being accessed by other users/.test(String(e))) {
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
          continue;
        }
        throw e;
      }
    }
  } finally {
    await db.$disconnect();
  }
}

export async function createPgTestDb(): Promise<{ name: string; url: string }> {
  const name = `lf_t_${randomBytes(6).toString("hex")}_test`;
  await adminExec(`CREATE DATABASE "${name}" TEMPLATE "${templateName()}"`);
  return { name, url: dbUrl(name) };
}

export async function dropPgTestDb(name: string) {
  if (!/^lf_[a-z0-9_]+_test$/.test(name)) throw new Error("Отказ: изтриват се само тестови бази lf_*_test.");
  await adminExec(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
