import { NextResponse } from "next/server";
import { getRawDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Публична liveness проверка (Render healthCheckPath): процесът отговаря и базата е достъпна.
 * Само ok/статус — без CRM статистика, PII, stack trace, env стойности или подробности за грешката.
 * Готовност за работа (schema версия, инициализирани данни): /api/ready.
 */
export async function GET() {
  try {
    const db = await getRawDb();
    await db.$queryRawUnsafe("SELECT 1");
    return NextResponse.json({ ok: true, service: "bds-leadflow" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, service: "bds-leadflow" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
