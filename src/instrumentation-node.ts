/**
 * Проверка на конфигурацията при старт на web сървъра (само Node.js runtime; виж src/instrumentation.ts).
 * Production (APP_ENV=production или процес в Render): невалидна конфигурация спира процеса веднага —
 * без празна SQLite база, без http canonical адрес, без demo режим. Съобщението съдържа само имената на
 * проблемните променливи, не техните стойности.
 */
import { getEnv } from "./lib/env";

const strict = process.env.APP_ENV === "production" || !!process.env.RENDER;
try {
  const env = getEnv();
  console.log(`[web] старт: APP_ENV=${env.APP_ENV}, APP_MODE=${env.APP_MODE}, база ${env.DATABASE_URL.startsWith("file:") ? "SQLite" : "PostgreSQL"}`);
} catch (e) {
  console.error(`[web] ${e instanceof Error ? e.message : "Невалидна конфигурация"}`);
  if (strict) process.exit(1);
}
