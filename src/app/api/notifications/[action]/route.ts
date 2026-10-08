import { z } from "zod";
import { SIMULATED_TRANSPORTS } from "@/domain/demo";
import { DomainError } from "@/domain/errors";
import { enqueueTest, fallbackEmailText, processOutbox } from "@/domain/notifications";
import { jsonBody } from "@/lib/body";
import { deliveriesEnabled, getEnv } from "@/lib/env";
import { localDateOf } from "@/lib/time";
import { api } from "@/lib/server";
import { emailConfigured, pushConfigured } from "@/providers/delivery";

/**
 * test — в demo: локален preview (simulated). В real: само с ALLOW_REAL_TEST_DELIVERY + конфигурация;
 *        записът се поставя в outbox и worker-ът го доставя. Неутрален текст, без CRM данни.
 * preview (GET) — in-app preview на днешното известие и резервния имейл. НЕ е изпратено известие.
 */
export const POST = api(async (ctx, req, p) => {
  if (p.action !== "test") throw new DomainError("NOT_FOUND", "Непознато действие.");
  const { channel } = z.object({ channel: z.enum(["PUSH", "EMAIL"]) }).parse(await jsonBody(req));
  const env = getEnv();
  if (ctx.mode === "real") {
    if (!env.ALLOW_REAL_TEST_DELIVERY) throw new DomainError("BLOCKED", "Реалната тестова доставка е изключена (ALLOW_REAL_TEST_DELIVERY=false).");
    if (!deliveriesEnabled(env)) throw new DomainError("BLOCKED", "Външните доставки са изключени (DELIVERIES_ENABLED=false) — worker-ът не изпраща.");
    if (channel === "PUSH" && !pushConfigured(env)) throw new DomainError("BLOCKED", "Липсват VAPID ключове.");
    if (channel === "EMAIL" && !emailConfigured(env)) throw new DomainError("BLOCKED", "Липсва SMTP конфигурация или OWNER_NOTIFY_EMAIL.");
  }
  const row = await enqueueTest(ctx, channel, env.ALLOW_REAL_TEST_DELIVERY);
  if (ctx.mode === "demo") {
    await processOutbox(ctx, { ...SIMULATED_TRANSPORTS, baseUrl: env.APP_BASE_URL });
    const after = await ctx.db.notificationOutbox.findUnique({ where: { id: row.id } });
    return { id: row.id, status: after?.status, note: "DEMO: локален preview — нищо не е изпратено." };
  }
  return { id: row.id, status: "queued", note: "Поставено в outbox; worker-ът ще опита доставка. provider_accepted ≠ доставено." };
});

export const GET = api(async (ctx, _req, p) => {
  if (p.action !== "preview") throw new DomainError("NOT_FOUND", "Непознато действие.");
  const env = getEnv();
  const localDate = localDateOf(ctx.clock.now());
  const rows = await ctx.db.notificationOutbox.findMany({ where: { localDate }, include: { deliveries: { select: { result: true, at: true, error: true } } } });
  const push = rows.find((r) => r.channel === "PUSH");
  const email = rows.find((r) => r.channel === "EMAIL");
  const payload = push ? (JSON.parse(push.payload) as { title: string; body: string }) : email ? (JSON.parse(email.payload) as { title: string; body: string }) : null;
  return {
    localDate,
    mode: ctx.mode,
    push: push ? { status: push.status, attempts: push.deliveries.length, lastError: push.lastError } : null,
    email: email ? { status: email.status, notBefore: email.notBefore, lastError: email.lastError, preview: payload ? fallbackEmailText(payload, localDate, email.notBefore, env.APP_BASE_URL) : null } : null,
    payload,
  };
});
