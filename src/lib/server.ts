import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/domain/errors";
import { SESSION_COOKIE, sessionUser } from "./auth";
import { getCtx, getDb, type Ctx } from "./db";
import { clientIpFrom, originAllowed } from "./requestGuards";

/**
 * Server-side защита на всяка CRM страница и API. (Proxy/middleware не се ползва като единствена защита.)
 */
export async function currentOwner() {
  const db = await getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionUser(db, token);
}

export async function requirePageOwner(nextPath = "/today"): Promise<Ctx & { username: string }> {
  const s = await currentOwner();
  if (!s) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  const ctx = await getCtx(s.user.username);
  return { ...ctx, username: s.user.username };
}

export { clientIpFrom, originAllowed } from "./requestGuards";

type Handler<T> = (ctx: Ctx, req: NextRequest, params: Record<string, string>) => Promise<T>;

export function api<T>(fn: Handler<T>, opts: { auth?: boolean } = {}) {
  return async (req: NextRequest, route: { params: Promise<Record<string, string>> }) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
        return NextResponse.json({ error: "Невалиден произход на заявката (CSRF защита)." }, { status: 403 });
      }
      let actor = "system";
      if (opts.auth !== false) {
        const s = await currentOwner();
        if (!s) return NextResponse.json({ error: "Нужен е вход." }, { status: 401 });
        actor = s.user.username;
      }
      const ctx = await getCtx(actor);
      const params = (await route?.params) ?? {};
      const out = await fn(ctx, req, params);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      if (e instanceof ZodError) {
        return NextResponse.json({ error: e.issues.map((i) => i.message).join(" "), issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
      }
      if (e instanceof DomainError) {
        const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : e.code === "VALIDATION" ? 400 : 409;
        return NextResponse.json({ error: e.message, code: e.code }, { status });
      }
      if (e instanceof SyntaxError) return NextResponse.json({ error: "Невалиден JSON." }, { status: 400 });
      console.error("[api]", req.method, req.nextUrl.pathname, e instanceof Error ? e.message : "грешка");
      return NextResponse.json({ error: "Вътрешна грешка. Опитай отново." }, { status: 500 });
    }
  };
}

export async function clientIp(): Promise<string> {
  return clientIpFrom(await headers());
}
