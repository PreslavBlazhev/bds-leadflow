import { NextResponse } from "next/server";
import { assertDbMode, getRawDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { schemaStatus } from "@/lib/schemaVersion";

export const dynamic = "force-dynamic";

/**
 * Публична readiness проверка: { ready: true } (200) или { ready: false } (503).
 * ready = валидна конфигурация + достъпна база + приложените миграции съвпадат точно с кода + базата е инициализирана
 * за APP_MODE. Подробностите (кои миграции, worker) са само за owner в Настройки → Здраве.
 */
export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    const env = getEnv();
    const db = await getRawDb();
    const schema = await schemaStatus(db);
    if (!schema.ok) return NextResponse.json({ ready: false }, { status: 503, headers });
    await assertDbMode(db, env.APP_MODE);
    return NextResponse.json({ ready: true }, { headers });
  } catch {
    return NextResponse.json({ ready: false }, { status: 503, headers });
  }
}
