import { appClock, type Ctx } from "@/lib/db";
import type { Env } from "@/lib/env";
import type { Transports } from "@/domain/notifications";
import { createSmtpTransport, createWebPushTransport, emailConfigured, pushConfigured } from "@/providers/delivery";
import { demoProvider } from "@/providers/candidates";
import type { PrismaClient } from "@prisma/client";

/** Транспорти според режима. В demo никога не се създават реални транспорти. */
export async function buildTransports(env: Env): Promise<Transports> {
  if (env.APP_MODE === "demo") {
    return { push: null, email: null, pushBlockedReason: "DEMO_MODE", emailBlockedReason: "DEMO_MODE", baseUrl: env.APP_BASE_URL };
  }
  return {
    push: pushConfigured(env) ? await createWebPushTransport(env) : null,
    email: emailConfigured(env) ? await createSmtpTransport(env) : null,
    pushBlockedReason: pushConfigured(env) ? undefined : "Липсват VAPID ключове",
    emailBlockedReason: emailConfigured(env) ? undefined : "Липсва SMTP конфигурация или OWNER_NOTIFY_EMAIL",
    baseUrl: env.APP_BASE_URL,
  };
}

export function discoveryFor(env: Env) {
  // Live discovery е BLOCKED до разрешен източник; в demo — синтетичният provider.
  return env.APP_MODE === "demo" ? demoProvider() : null;
}

export async function workerCtx(db: PrismaClient, env: Env): Promise<Ctx> {
  return { db, mode: env.APP_MODE, clock: await appClock(db, env.APP_MODE), actor: "worker" };
}
