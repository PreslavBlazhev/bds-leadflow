import type { Prisma } from "@prisma/client";
import type { DbLike } from "@/lib/db";
import { addDays, zonedToUtc } from "@/lib/time";

/**
 * Статистика САМО от DB. Дефиниции:
 *  - Опит = Activity тип CALL (записан от мен резултат по телефон). DIAL_INTENT, NOTE, STATUS_CHANGE не са опит.
 *  - Разговор = CALL с callConnected = true.
 *  - Заинтересовани = различни бизнеси с резултат INTERESTED, SEND_OFFER или WON в периода.
 *  - Среща = само Activity тип MEETING (не се извежда от интерес).
 *  - Спечелени = създадени Client записи в периода. Договорена стойност ≠ получени пари.
 *  - Получени = ръчно записани ReceivedPayment в периода.
 */
export interface StatsFilter {
  from: string; // localDate включително
  to: string; // localDate включително
  city?: string;
  category?: string;
}

export interface Rate {
  label: string;
  num: number;
  den: number;
  value: number | null;
  definition: string;
  sample: "none" | "small" | "ok";
}

function rate(label: string, num: number, den: number, definition: string): Rate {
  return { label, num, den, value: den > 0 ? num / den : null, definition, sample: den === 0 ? "none" : den < 30 ? "small" : "ok" };
}

export async function computeStats(db: DbLike, f: StatsFilter) {
  const start = zonedToUtc(f.from, "00:00");
  const end = zonedToUtc(addDays(f.to, 1), "00:00");
  const bw: Prisma.BusinessWhereInput = { ...(f.city ? { city: f.city } : {}), ...(f.category ? { category: f.category } : {}) };
  const inRange = { gte: start, lt: end };

  const [assigned, attempts, conversations, interestedRows, meetings, offersCreated, offersSent, offersAccepted, clients, payments, otherContacts] = await Promise.all([
    db.dailyBatchItem.count({ where: { issuedAt: inRange, business: bw } }),
    db.activity.count({ where: { type: "CALL", occurredAt: inRange, business: bw } }),
    db.activity.count({ where: { type: "CALL", callConnected: true, occurredAt: inRange, business: bw } }),
    db.activity.findMany({ where: { outcome: { in: ["INTERESTED", "SEND_OFFER", "WON"] }, occurredAt: inRange, business: bw }, select: { businessId: true }, distinct: ["businessId"] }),
    db.activity.count({ where: { type: "MEETING", occurredAt: inRange, business: bw } }),
    db.offer.count({ where: { createdAt: inRange, business: bw } }),
    db.offer.count({ where: { sentAt: inRange, business: bw } }),
    db.offer.count({ where: { status: "ACCEPTED", decidedAt: inRange, business: bw } }),
    db.client.findMany({ where: { createdAt: inRange, business: bw }, select: { agreedOneTimeCents: true, monthlyCents: true } }),
    db.receivedPayment.aggregate({ where: { receivedOn: { gte: f.from, lte: f.to }, client: { business: bw } }, _sum: { amountCents: true }, _count: true }),
    db.activity.count({ where: { type: "CONTACT_OTHER", occurredAt: inRange, business: bw } }),
  ]);
  const businessesWithConversation = await db.activity.findMany({
    where: { type: "CALL", callConnected: true, occurredAt: inRange, business: bw },
    select: { businessId: true },
    distinct: ["businessId"],
  });
  const won = clients.length;
  const agreedOneTime = clients.reduce((a, c) => a + c.agreedOneTimeCents, 0);
  const agreedMonthly = clients.reduce((a, c) => a + (c.monthlyCents ?? 0), 0);
  const interested = interestedRows.length;

  return {
    filter: f,
    counts: { assigned, attempts, conversations, interested, meetings, offersCreated, offersSent, offersAccepted, won, otherContacts, paymentsCount: payments._count },
    money: { agreedOneTimeCents: agreedOneTime, agreedMonthlyCents: agreedMonthly, receivedCents: payments._sum.amountCents ?? 0 },
    rates: [
      rate("Свързване", conversations, attempts, "Разговори ÷ опити (CALL записи)"),
      rate("Интерес", interested, businessesWithConversation.length, "Заинтересовани бизнеси ÷ бизнеси с поне един разговор"),
      rate("Оферта → приета", offersAccepted, offersSent, "Приети оферти ÷ изпратени (ръчно маркирани) оферти"),
      rate("Спечелени", won, businessesWithConversation.length, "Нови клиенти ÷ бизнеси с поне един разговор"),
    ],
  };
}

export async function statsByCategory(db: DbLike, f: StatsFilter) {
  const cats = ["restaurant", "auto", "beauty", "home"];
  return Promise.all(cats.map(async (c) => ({ category: c, ...(await computeStats(db, { ...f, category: c })).counts })));
}
