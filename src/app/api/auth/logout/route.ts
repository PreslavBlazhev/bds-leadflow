import { NextResponse, type NextRequest } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { originAllowed } from "@/lib/server";

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return NextResponse.json({ error: "Невалиден произход на заявката." }, { status: 403 });
  const db = await getDb();
  await destroySession(db, req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  const env = getEnv();
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: env.APP_ENV === "production" || env.APP_BASE_URL.startsWith("https://"), path: "/", maxAge: 0 });
  return res;
}
