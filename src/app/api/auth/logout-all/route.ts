import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { audit } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { api } from "@/lib/server";

/** Изход от всички устройства: изтрива всички owner сесии (вкл. текущата). Паролата не се променя. */
export const POST = api(async (ctx) => {
  const r = await ctx.db.session.deleteMany({});
  await audit(ctx.db, ctx.actor, "auth.logout_all", "Session", undefined, { revoked: r.count });
  const env = getEnv();
  const res = NextResponse.json({ ok: true, revoked: r.count }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: env.APP_ENV === "production" || env.APP_BASE_URL.startsWith("https://"), path: "/", maxAge: 0 });
  return res;
});
