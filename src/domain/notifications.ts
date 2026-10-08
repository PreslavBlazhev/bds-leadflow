import { createHash, randomBytes } from "node:crypto";
import type { NotificationOutbox, PrismaClient } from "@prisma/client";
import type { Ctx } from "@/lib/db";
import { fmtDateTime, localDateOf } from "@/lib/time";
import type { EmailTransport, PushTransport } from "@/providers/delivery";

/**
 * Outbox dispatcher. Работи в worker-а (и в тестовете с mock транспорти).
 * - Claim с условен UPDATE + lease → два worker-а не обработват един запис; crash → lease изтича → безопасно продължаване.
 * - Без отворена DB транзакция по време на HTTP/SMTP.
 * - provider_accepted ≠ доставено ≠ прочетено.
 * - Един логически daily имейл (dedupeKey UNIQUE), независимо от броя push устройства.
 * - DEMO_MODE: никакви транспорти, само simulated previews.
 * - Дневните известия са само за СВОЯ ден: запис за минала местна дата не се изпраща (skipped), напр. след
 *   прекъсване или пренос — никога „вчерашният списък е готов“.
 * - cutover_hold: пренесени неизпратени задачи; не се обработват автоматично (виж docs/CUTOVER-AND-ROLLBACK.md).
 *
 * Резервен имейл (FALLBACK_EMAIL) — точно правило:
 *   а) веднага, ако push не може да бъде опитан или окончателно е отказан: няма активни устройства, push не е
 *      конфигуриран, всички устройства са отказани (вкл. 404/410), или изчерпани опити;
 *   б) иначе в notBefore = max(планиран час, действително публикуване) + fallbackDelayMinutes,
 *      ОСВЕН ако дотогава: owner е отворил днешния списък (DailyAcknowledgement), или service worker на
 *      устройство е потвърдил показване на известието (swReceivedAt).
 *   „provider_accepted“ (приемане от push доставчика) НЕ спира имейла — не доказва показване.
 */

export interface Transports {
  push: PushTransport | null;
  email: EmailTransport | null;
  pushBlockedReason?: string;
  emailBlockedReason?: string;
  baseUrl: string;
}

export const MAX_ATTEMPTS = 5;
const LEASE_MS = 2 * 60_000;

export function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/** Еднократен token за разписка от service worker-а: суровият е в payload-а към устройството, в базата — sha256. */
export const receiptHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function pushPayloadWithReceipt(msg: { title: string; body: string; url?: string }) {
  const rt = randomBytes(18).toString("base64url");
  return { payload: JSON.stringify({ ...msg, url: msg.url ?? "/today", rt }), receiptTokenHash: receiptHash(rt) };
}

const DAILY_KINDS = ["DAILY_READY", "FALLBACK_EMAIL"];

export async function processOutbox(ctx: Pick<Ctx, "db" | "clock" | "mode">, tr: Transports, limit = 20) {
  const now = ctx.clock.now();
  const today = localDateOf(now);
  const due = await ctx.db.notificationOutbox.findMany({
    where: {
      OR: [
        { status: { in: ["queued", "retry_scheduled"] }, notBefore: { lte: now } },
        { status: "processing", leaseUntil: { lt: now } }, // възстановяване след crash
      ],
    },
    orderBy: { notBefore: "asc" },
    take: limit,
  });
  const results: { id: string; status: string }[] = [];
  for (const row of due) {
    const claimed = await ctx.db.notificationOutbox.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: "processing", leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue; // друг процес го взе
    const attempt = row.attempts + 1;
    if (DAILY_KINDS.includes(row.kind) && row.localDate && row.localDate < today) {
      results.push({ id: row.id, status: await finish(ctx.db, row.id, "skipped", { lastError: `Остаряло: известие за ${row.localDate} не се изпраща на ${today}.` }) });
      continue;
    }
    const status = row.channel === "PUSH" ? await deliverPush(ctx, tr, row, attempt) : await deliverEmail(ctx, tr, row, attempt);
    results.push({ id: row.id, status });
  }
  return results;
}

async function finish(db: PrismaClient, id: string, status: string, extra: Partial<NotificationOutbox> = {}) {
  await db.notificationOutbox.update({ where: { id }, data: { status, leaseUntil: null, ...extra } });
  return status;
}

/** Fallback имейлът става due веднага (липсват/отказани push канали). Само ако още чака. */
async function triggerEmailNow(ctx: Pick<Ctx, "db" | "clock">, localDate: string | null) {
  if (!localDate) return;
  await ctx.db.notificationOutbox.updateMany({
    where: { dedupeKey: `email:fallback:${localDate}`, status: { in: ["queued", "retry_scheduled"] } },
    data: { notBefore: ctx.clock.now() },
  });
}

async function deliverPush(ctx: Pick<Ctx, "db" | "clock" | "mode">, tr: Transports, row: NotificationOutbox, attempt: number): Promise<string> {
  const now = ctx.clock.now();
  const subs = await ctx.db.pushSubscription.findMany({ where: { revokedAt: null, expiredAt: null } });
  if (ctx.mode === "demo") {
    for (const s of subs) await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, subscriptionId: s.id, result: "simulated", at: now } });
    if (subs.length === 0) {
      await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, result: "simulated", error: "Няма регистрирани устройства (demo)", at: now } });
      if (row.kind === "DAILY_READY") await triggerEmailNow(ctx, row.localDate);
    }
    return finish(ctx.db, row.id, "simulated", { lastError: null });
  }
  if (!tr.push) {
    if (row.kind === "DAILY_READY") await triggerEmailNow(ctx, row.localDate);
    return finish(ctx.db, row.id, "failed", { lastError: `BLOCKED: ${tr.pushBlockedReason ?? "Push не е конфигуриран"}` });
  }
  if (subs.length === 0) {
    if (row.kind === "DAILY_READY") await triggerEmailNow(ctx, row.localDate);
    return finish(ctx.db, row.id, "failed", { lastError: "Няма активни push устройства" });
  }
  const done = await ctx.db.deliveryAttempt.findMany({ where: { outboxId: row.id, result: "provider_accepted" }, select: { subscriptionId: true } });
  const doneIds = new Set(done.map((d) => d.subscriptionId));
  let accepted = doneIds.size;
  let simulated = 0;
  let retryable = 0;
  for (const s of subs.filter((x) => !doneIds.has(x.id))) {
    const r = await tr.push.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, row.payload);
    if (r.ok && r.dryRun) {
      simulated++;
      await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, subscriptionId: s.id, result: "simulated", error: "NOTIFY_DRY_RUN: изградено, не е изпратено", at: now } });
    } else if (r.ok) {
      accepted++;
      await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, subscriptionId: s.id, result: "provider_accepted", statusCode: r.statusCode, at: now } });
      await ctx.db.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: now, failureCount: 0 } });
    } else {
      await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, subscriptionId: s.id, result: r.expired ? "expired" : "failed", statusCode: r.statusCode, error: r.error, at: now } });
      await ctx.db.pushSubscription.update({
        where: { id: s.id },
        data: { lastFailureAt: now, failureCount: { increment: 1 }, ...(r.expired ? { expiredAt: now } : {}) },
      });
      if (!r.expired) retryable++;
    }
  }
  if (accepted > 0) return finish(ctx.db, row.id, "provider_accepted", { lastError: retryable ? `${retryable} устройства с грешка` : null });
  if (simulated > 0) return finish(ctx.db, row.id, "simulated", { lastError: "NOTIFY_DRY_RUN: нищо не е изпратено" });
  if (retryable > 0 && attempt < MAX_ATTEMPTS) {
    return finish(ctx.db, row.id, "retry_scheduled", { notBefore: new Date(now.getTime() + backoffMs(attempt)), lastError: "Временна грешка при push" });
  }
  if (row.kind === "DAILY_READY") await triggerEmailNow(ctx, row.localDate);
  return finish(ctx.db, row.id, "failed", { lastError: "Всички push устройства отказаха (окончателно)" });
}

export function fallbackEmailText(payload: { body: string }, localDate: string | null, notBefore: Date, baseUrl: string) {
  return {
    subject: "BDS LeadFlow — днешният списък (резервен имейл)",
    text: [
      payload.body,
      "",
      `Този резервен имейл се изпраща, защото списъкът за ${localDate ?? "днес"} не е отворен до ${fmtDateTime(notBefore)}.`,
      "Това НЕ е доказателство, че push известието не е доставено.",
      "",
      `Отвори: ${baseUrl.replace(/\/$/, "")}/today`,
    ].join("\n"),
  };
}

async function deliverEmail(ctx: Pick<Ctx, "db" | "clock" | "mode">, tr: Transports, row: NotificationOutbox, attempt: number): Promise<string> {
  const now = ctx.clock.now();
  if (row.kind === "FALLBACK_EMAIL" && row.localDate) {
    // Проверка НЕПОСРЕДСТВЕНО преди изпращане: owner е отворил списъка, или устройство е показало push-а.
    const ack = await ctx.db.dailyAcknowledgement.findUnique({ where: { localDate: row.localDate } });
    if (ack) return finish(ctx.db, row.id, "acknowledged", { lastError: "Не е нужен: owner е отворил днешния списък." });
    const shown = await ctx.db.notificationOutbox.findFirst({ where: { localDate: row.localDate, kind: "DAILY_READY", swReceivedAt: { not: null } }, select: { id: true } });
    if (shown) return finish(ctx.db, row.id, "skipped", { lastError: "Не е нужен: service worker потвърди показване на push известието." });
  }
  if (ctx.mode === "demo") {
    await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, result: "simulated", error: "DEMO_MODE: само preview, не е изпратен", at: now } });
    return finish(ctx.db, row.id, "simulated", { providerMessageId: null, lastError: null });
  }
  if (!tr.email) return finish(ctx.db, row.id, "failed", { lastError: `BLOCKED: ${tr.emailBlockedReason ?? "SMTP не е конфигуриран"}` });
  const payload = JSON.parse(row.payload) as { body: string; title: string };
  const msg = row.kind === "FALLBACK_EMAIL" ? fallbackEmailText(payload, row.localDate, row.notBefore, tr.baseUrl) : { subject: payload.title, text: payload.body };
  const r = await tr.email.send({ ...msg, idempotencyKey: row.dedupeKey });
  if (r.ok && r.dryRun) {
    await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, result: "simulated", error: "NOTIFY_DRY_RUN: изграден, не е изпратен", at: now } });
    return finish(ctx.db, row.id, "simulated", { providerMessageId: null, lastError: null });
  }
  if (r.ok) {
    await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, result: "provider_accepted", at: now } });
    return finish(ctx.db, row.id, "provider_accepted", { providerMessageId: r.messageId, lastError: null });
  }
  await ctx.db.deliveryAttempt.create({ data: { outboxId: row.id, result: "failed", error: r.error, at: now } });
  if (r.retryable && attempt < MAX_ATTEMPTS) {
    return finish(ctx.db, row.id, "retry_scheduled", { notBefore: new Date(now.getTime() + backoffMs(attempt)), lastError: r.error });
  }
  return finish(ctx.db, row.id, "failed", { lastError: r.error });
}

/** Тестови известия: в demo — preview; в real — само с ALLOW_REAL_TEST_DELIVERY, неутрален текст, без CRM данни. */
export async function enqueueTest(ctx: Pick<Ctx, "db" | "clock" | "mode">, channel: "PUSH" | "EMAIL", allowReal: boolean) {
  if (ctx.mode === "real" && !allowReal) throw new Error("Реалната тестова доставка не е разрешена (ALLOW_REAL_TEST_DELIVERY=false).");
  const now = ctx.clock.now();
  const p = pushPayloadWithReceipt({ title: "BDS LeadFlow — тест", body: "Тестово известие. Не съдържа данни за клиенти.", url: "/today" });
  return ctx.db.notificationOutbox.create({
    data: {
      dedupeKey: `test:${channel.toLowerCase()}:${now.getTime()}`,
      channel,
      kind: channel === "PUSH" ? "TEST_PUSH" : "TEST_EMAIL",
      payload: p.payload,
      receiptTokenHash: channel === "PUSH" ? p.receiptTokenHash : null,
      notBefore: now,
    },
  });
}

/**
 * Разписка от service worker-а (без вход: token-ът е в криптирания push payload). "shown" = showNotification
 * е изпълнен на устройство; "clicked" = owner е натиснал известието. Нито едно не доказва, че е прочетено.
 */
export async function recordPushReceipt(db: PrismaClient, token: string, event: "shown" | "clicked", now: Date): Promise<boolean> {
  const row = await db.notificationOutbox.findFirst({ where: { receiptTokenHash: receiptHash(token), channel: "PUSH" }, select: { id: true, swReceivedAt: true, openedAt: true } });
  if (!row) return false;
  await db.notificationOutbox.update({
    where: { id: row.id },
    data: event === "shown" ? { swReceivedAt: row.swReceivedAt ?? now } : { openedAt: row.openedAt ?? now, swReceivedAt: row.swReceivedAt ?? now },
  });
  return true;
}
