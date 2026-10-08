import { previewSelection, publishDailyBatch } from "@/domain/batch";
import { acknowledgeToday } from "@/domain/crm";
import { demoPrepare, simulateNextDay } from "@/domain/demo";
import { DomainError } from "@/domain/errors";
import { addDays, localDateOf } from "@/lib/time";
import { api } from "@/lib/server";

/**
 * publish — idempotent „Създай днешния списък“ (повторно натискане връща същия списък / допълва частичен).
 * ack — днешният списък е отворен (отменя резервния имейл, ако още не е изпратен).
 * prepare / next-day — само demo (backend отказва в real).
 */
export const POST = api(async (ctx, _req, p) => {
  switch (p.action) {
    case "publish":
      return publishDailyBatch(ctx, { trigger: "manual" });
    case "ack":
      return { ack: await acknowledgeToday(ctx, "open:/today") };
    case "prepare":
      return demoPrepare(ctx);
    case "next-day":
      return simulateNextDay(ctx);
    default:
      throw new DomainError("NOT_FOUND", "Непознато действие.");
  }
});

/** preview — „Прегледай утре“: само четене, без reservation. */
export const GET = api(async (ctx, req, p) => {
  if (p.action !== "preview") throw new DomainError("NOT_FOUND", "Непознато действие.");
  const now = ctx.clock.now();
  const date = req.nextUrl.searchParams.get("date") ?? addDays(localDateOf(now), 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DomainError("VALIDATION", "Невалидна дата.");
  return previewSelection(ctx.db, ctx.mode, now, date);
});
