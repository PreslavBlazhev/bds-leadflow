import type { Env } from "@/lib/env";

/**
 * Транспорти за известия към МЕН (owner). Само един имейл адаптер (SMTP чрез nodemailer).
 * В DEMO_MODE транспортите изобщо не се създават — dispatcher-ът записва preview/simulated.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** dryRun: заявката е изградена/валидирана локално, но НЕ е изпратена (NOTIFY_DRY_RUN). */
export type PushSendResult = { ok: true; statusCode: number; dryRun?: boolean } | { ok: false; statusCode?: number; expired: boolean; error: string };

export interface PushTransport {
  send(target: PushTarget, payload: string): Promise<PushSendResult>;
}

export type EmailSendResult = { ok: true; messageId: string | null; dryRun?: boolean } | { ok: false; error: string; retryable: boolean };

export interface EmailTransport {
  send(msg: { subject: string; text: string; idempotencyKey: string }): Promise<EmailSendResult>;
}

export function pushConfigured(env: Env): boolean {
  return !!(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export function emailConfigured(env: Env): boolean {
  return !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM && env.OWNER_NOTIFY_EMAIL);
}

export async function createWebPushTransport(env: Env): Promise<PushTransport> {
  if (env.APP_MODE !== "real") throw new Error("Реален push транспорт е забранен извън real режим.");
  if (!pushConfigured(env)) throw new Error("VAPID не е конфигуриран.");
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(env.VAPID_SUBJECT!, env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  return {
    async send(target, payload) {
      if (env.NOTIFY_DRY_RUN) {
        // Криптира payload-а и подписва VAPID заявката както при реално изпращане, но без мрежова заявка.
        try {
          webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, { TTL: 4 * 3600 });
          return { ok: true, statusCode: 0, dryRun: true };
        } catch (e) {
          return { ok: false, expired: false, error: `dry-run: ${e instanceof Error ? e.message.slice(0, 120) : "невалиден абонамент"}` };
        }
      }
      try {
        const r = await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, { TTL: 4 * 3600, timeout: 15_000 });
        return { ok: true, statusCode: r.statusCode };
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode;
        return { ok: false, statusCode, expired: statusCode === 404 || statusCode === 410, error: statusCode ? `HTTP ${statusCode}` : "Мрежова грешка" };
      }
    },
  };
}

export async function createSmtpTransport(env: Env): Promise<EmailTransport> {
  if (env.APP_MODE !== "real") throw new Error("Реален имейл транспорт е забранен извън real режим.");
  if (!emailConfigured(env)) throw new Error("SMTP не е конфигуриран.");
  const nodemailer = (await import("nodemailer")).default;
  // NOTIFY_DRY_RUN: nodemailer jsonTransport — пълно изграждане на съобщението, без SMTP връзка.
  const transporter = env.NOTIFY_DRY_RUN
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
        connectionTimeout: 15_000,
        socketTimeout: 20_000,
      });
  return {
    async send(msg) {
      try {
        // SMTP няма idempotency key; Message-ID е детерминиран, но повторна доставка при timeout след приемане остава възможен риск (документиран).
        const info = await transporter.sendMail({
          from: env.SMTP_FROM,
          to: env.OWNER_NOTIFY_EMAIL, // само до конфигурирания owner адрес
          subject: msg.subject,
          text: msg.text,
          messageId: `<${msg.idempotencyKey.replace(/[^a-zA-Z0-9.-]/g, ".")}@bds-leadflow.local>`,
        });
        return { ok: true, messageId: info.messageId ?? null, ...(env.NOTIFY_DRY_RUN ? { dryRun: true } : {}) };
      } catch (e) {
        const code = (e as { responseCode?: number }).responseCode;
        return { ok: false, error: code ? `SMTP ${code}` : "SMTP грешка", retryable: !code || code < 500 };
      }
    },
  };
}
