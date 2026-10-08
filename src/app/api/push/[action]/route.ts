import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { jsonBody } from "@/lib/body";
import { audit } from "@/lib/db";
import { api } from "@/lib/server";

const sub = z.object({
  endpoint: z.url().refine((u) => u.startsWith("https://"), "Push endpoint трябва да е https."),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  label: z.string().max(80).optional(),
});

/** Управление на push устройствата на owner-а. Endpoint/ключовете са чувствителни — не се връщат към UI. */
export const POST = api(async (ctx, req, p) => {
  const b = await jsonBody(req);
  if (p.action === "subscribe") {
    const v = sub.parse(b);
    const s = await ctx.db.pushSubscription.upsert({
      where: { endpoint: v.endpoint },
      create: { endpoint: v.endpoint, p256dh: v.keys.p256dh, auth: v.keys.auth, label: v.label },
      update: { p256dh: v.keys.p256dh, auth: v.keys.auth, label: v.label, revokedAt: null, expiredAt: null, failureCount: 0 },
    });
    await audit(ctx.db, ctx.actor, "push.subscribe", "PushSubscription", s.id);
    return { id: s.id };
  }
  if (p.action === "check") {
    // Знае ли сървърът абонамента на това устройство (напр. след смяна на адреса subscription от localhost не важи).
    const v = z.object({ endpoint: z.string().max(2000) }).parse(b);
    const s = await ctx.db.pushSubscription.findUnique({ where: { endpoint: v.endpoint }, select: { revokedAt: true, expiredAt: true } });
    return { known: !!s, active: !!s && !s.revokedAt && !s.expiredAt };
  }
  if (p.action === "revoke") {
    const v = z.object({ id: z.string().optional(), endpoint: z.string().optional() }).parse(b);
    const n = await ctx.db.pushSubscription.updateMany({ where: v.id ? { id: v.id } : { endpoint: v.endpoint ?? "-" }, data: { revokedAt: ctx.clock.now() } });
    await audit(ctx.db, ctx.actor, "push.revoke", "PushSubscription", v.id);
    return { revoked: n.count };
  }
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});
