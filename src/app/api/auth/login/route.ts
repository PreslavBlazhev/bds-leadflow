import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hashPassword, createSession, loginBlocked, recordLogin, SESSION_COOKIE, verifyPassword } from "@/lib/auth";
import { audit, getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { clientIpFrom, originAllowed } from "@/lib/server";

const input = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) });
const GENERIC = "Невалидно потребителско име или парола.";
let dummyHash: Promise<string> | null = null;

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return NextResponse.json({ error: "Невалиден произход на заявката." }, { status: 403 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: GENERIC }, { status: 400 });
  const db = await getDb();
  const env = getEnv();
  const ip = clientIpFrom(req.headers, env);
  const keys = [`u:${parsed.data.username.toLowerCase()}`, `ip:${ip}`];
  if (await loginBlocked(db, keys)) {
    return NextResponse.json({ error: "Твърде много неуспешни опити. Опитай след 15 минути." }, { status: 429 });
  }
  const user = await db.user.findUnique({ where: { username: parsed.data.username } });
  // Винаги проверяваме хеш (и при липсващ потребител), за да не издаваме чрез време кой съществува.
  const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : (await verifyPassword(await (dummyHash ??= hashPassword(crypto.randomUUID())), parsed.data.password), false);
  await recordLogin(db, keys, ok);
  if (!ok || !user) return NextResponse.json({ error: GENERIC }, { status: 401 });
  const s = await createSession(db, user.id, env.SESSION_TTL_HOURS, req.headers.get("user-agent") ?? undefined);
  await audit(db, user.username, "auth.login");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.token, {
    httpOnly: true,
    sameSite: "lax",
    // production: APP_BASE_URL е задължително https → Secure винаги; локално по http — без Secure.
    secure: env.APP_ENV === "production" || env.APP_BASE_URL.startsWith("https://"),
    path: "/",
    expires: s.expiresAt,
  });
  return res;
}
