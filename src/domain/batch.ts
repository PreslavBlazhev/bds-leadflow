import type { PrismaClient } from "@prisma/client";
import { audit, isUniqueViolation, lockKey, tx, type Ctx, type DbLike, type Tx } from "@/lib/db";
import { addDays, localDateOf, zonedToUtc } from "@/lib/time";
import { CONTACT_ACTIVITY_TYPES } from "./constants";
import { buildEligibilityCtx, eligiblePool, type ScoredCandidate } from "./eligibility";
import { humanReasonText } from "./reasons";
import { getSettings, type Settings } from "./settings";
import { newListGate, realOnlyFor, type Gate } from "./activeList";
import { pushPayloadWithReceipt } from "./notifications";

export interface Selection {
  picked: { c: ScoredCandidate; bucket: string }[];
  notes: string[];
  plan: Record<string, { quota: number; available: number; taken: number }>;
}

/**
 * Квоти: приоритетни градове (Варна 15, Плевен 5) + "други" само от ИЗБРАНИ градове (5).
 * Недостигът се преразпределя само между разрешените градове, с обяснение. Без скрито разширяване.
 * `already` = бройки по bucket в съществуващ частичен списък (допълване, без подмяна).
 */
export function selectWithQuotas(pool: ScoredCandidate[], s: Settings, slots: number, already: Record<string, number> = {}): Selection {
  const notes: string[] = [];
  const buckets: { key: string; quota: number; cities: string[] }[] = s.priorityCities
    .filter((c) => c.enabled)
    .map((c) => ({ key: c.name, quota: c.quota, cities: [c.name] }));
  if (s.otherCities.length > 0) buckets.push({ key: "Други", quota: s.otherQuota, cities: s.otherCities });
  else if (s.otherQuota > 0) {
    notes.push(`Няма избрани други градове — ${s.otherQuota} места за „други“ се преразпределят само между ${buckets.map((b) => b.key).join("/")}.`);
  }

  const used = new Set<string>();
  const picked: Selection["picked"] = [];
  const plan: Selection["plan"] = {};
  for (const b of buckets) {
    const avail = pool.filter((c) => b.cities.includes(c.b.city));
    const want = Math.max(0, b.quota - (already[b.key] ?? 0));
    const take = avail.slice(0, Math.min(want, slots - picked.length));
    take.forEach((c) => {
      used.add(c.b.id);
      picked.push({ c, bucket: b.key });
    });
    plan[b.key] = { quota: b.quota, available: avail.length, taken: take.length };
    if (avail.length < want) notes.push(`${b.key}: само ${avail.length} допустими при квота ${want}.`);
  }
  // Преразпределяне на свободните места към останалите кандидати от РАЗРЕШЕНИТЕ градове (по глобалния ред).
  const free = slots - picked.length;
  if (free > 0) {
    const rest = pool.filter((c) => !used.has(c.b.id) && buckets.some((b) => b.cities.includes(c.b.city)));
    const extra = rest.slice(0, free);
    for (const c of extra) {
      const bk = buckets.find((b) => b.cities.includes(c.b.city))!;
      picked.push({ c, bucket: bk.key });
      plan[bk.key]!.taken += 1;
    }
    if (extra.length > 0) notes.push(`${extra.length} места преразпределени към ${[...new Set(extra.map((e) => e.b.city))].join(", ")}.`);
  }
  // Крайна поредност — глобалният стабилен ред (score ↓, свежест ↓, id ↑).
  const order = new Map(pool.map((c, i) => [c.b.id, i]));
  picked.sort((a, b) => order.get(a.c.b.id)! - order.get(b.c.b.id)!);
  return { picked, notes, plan };
}

/** Кратка, разбираема причина за подбора (техническите подробности са в детайлите на контакта). */
export function selectionReason(c: ScoredCandidate): string {
  return humanReasonText(c.score, c.b);
}

export interface PublishResult {
  batchId: string;
  localDate: string;
  created: boolean;
  added: number;
  total: number;
  target: number;
  shortfallReason: string | null;
  paused?: boolean;
  /** Реален режим: защо нов списък не е издаден/допълнен (неработен ден, преди часа, активен списък, без кандидати). */
  blocked?: Gate;
}

export function scheduledAtFor(localDate: string, s: Settings): Date {
  return zonedToUtc(localDate, s.publishTime);
}

async function dueFollowUpsCount(t: DbLike, localDate: string): Promise<number> {
  const end = zonedToUtc(addDays(localDate, 1), "00:00");
  return t.followUp.count({ where: { status: "OPEN", dueAt: { lt: end }, business: { suppressions: { none: { liftedAt: null, type: "DNC" } } } } });
}

/**
 * Публикува (или допълва) дневния списък за localDate. Idempotent:
 * - съществуващ пълен списък → връща се същият;
 * - частичен → допълва се до целта, без подмяна на издадените редове;
 * - eligibility се проверява наново ВЪТРЕ в транзакцията;
 * - outbox записите се създават в същата транзакция (не се губят при crash).
 * Инварианти в DB: DailyBatch.localDate UNIQUE, DailyBatchItem.businessId UNIQUE, (batchId, position) UNIQUE.
 */
export async function publishDailyBatch(
  ctx: Pick<Ctx, "db" | "clock" | "mode" | "actor">,
  opts: { localDate?: string; trigger: "manual" | "scheduler" | "demo"; late?: boolean } = { trigger: "manual" },
): Promise<PublishResult> {
  const now = ctx.clock.now();
  const localDate = opts.localDate ?? localDateOf(now);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await tx(ctx.db, (t) => publishInTx(t, ctx, localDate, now, opts));
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue; // конкурентна заявка е публикувала — четем наново
      throw e;
    }
  }
  throw new Error("Неуспешно публикуване след повторни опити");
}

async function publishInTx(
  t: Tx,
  ctx: Pick<Ctx, "mode" | "actor">,
  localDate: string,
  now: Date,
  opts: { trigger: string; late?: boolean },
): Promise<PublishResult> {
  // PostgreSQL: web + няколко worker-а се редят тук (transaction-scoped advisory lock), затова всяка следваща
  // транзакция вижда вече публикувания списък и неговите известия. Unique ограниченията остават последна защита.
  await lockKey(t, "publish-daily-batch");
  const s = await getSettings(t);
  const existing = await t.dailyBatch.findUnique({ where: { localDate }, include: { items: true } });
  const target = existing?.target ?? s.dailyTarget;
  if (existing && existing.items.length >= target) {
    return { batchId: existing.id, localDate, created: false, added: 0, total: existing.items.length, target, shortfallReason: existing.shortfallReason };
  }
  if (!existing && (s.paused || s.pauseNewLists)) {
    return { batchId: "", localDate, created: false, added: 0, total: 0, target, shortfallReason: "Новите списъци са на пауза.", paused: true };
  }
  // Реален режим: един активен списък до приключване, само в работни дни, след часа (виж activeList.ts).
  const realOnly = realOnlyFor(ctx.mode, s);
  const notIssued = (g: Gate): PublishResult => ({
    batchId: existing?.id ?? "",
    localDate,
    created: false,
    added: 0,
    total: existing?.items.length ?? 0,
    target,
    shortfallReason: existing?.shortfallReason ?? null,
    blocked: g,
  });
  const gate = await newListGate(t, s, localDate, now, { existing: !!existing, realOnly });
  if (!gate.ok) return notIssued(gate);

  const ectx = await buildEligibilityCtx(t, ctx.mode, s, now);
  const pool = await eligiblePool(t, ectx);
  // Без допустими кандидати не се създава празен реален списък (и не се изпраща известие).
  if (realOnly && !existing && pool.length === 0) {
    return notIssued({ ok: false, code: "NO_CANDIDATES", reason: "Няма допустими нови кандидати в запаса — нов списък не е издаден." });
  }
  const already: Record<string, number> = {};
  for (const it of existing?.items ?? []) already[it.bucket] = (already[it.bucket] ?? 0) + 1;
  const slots = target - (existing?.items.length ?? 0);
  const sel = selectWithQuotas(pool, s, slots, already);

  const scheduledAt = scheduledAtFor(localDate, s);
  const batch =
    existing ??
    (await t.dailyBatch.create({
      data: { localDate, target, scheduledAt, publishedAt: now, late: !!opts.late, status: "PUBLISHED" },
    }));
  const startPos = (existing?.items.reduce((m, i) => Math.max(m, i.position), 0) ?? 0) + 1;
  let pos = startPos;
  for (const p of sel.picked) {
    await t.dailyBatchItem.create({
      data: { batchId: batch.id, businessId: p.c.b.id, position: pos++, bucket: p.bucket, scoreAtIssue: p.c.score.score, reason: selectionReason(p.c), issuedAt: now },
    });
    // firstIssuedAt се задава само ако липсва — никога не се презаписва/нулира.
    const upd = await t.business.updateMany({ where: { id: p.c.b.id, firstIssuedAt: null }, data: { firstIssuedAt: now } });
    if (upd.count !== 1) throw new Error(`Инвариант: ${p.c.b.ref} вече има first_issued_at`);
    await t.scoreEvaluation.create({
      data: { businessId: p.c.b.id, ruleVersion: p.c.score.ruleVersion, score: p.c.score.score, breakdown: JSON.stringify(p.c.score.lines) },
    });
  }
  const total = (existing?.items.length ?? 0) + sel.picked.length;
  const staleNote = total < target ? await staleCandidatesNote(t, s, ectx.mode, now) : "";
  const shortfall =
    total < target
      ? `Само ${total} от ${target} допустими нови контакта. ${sel.notes.join(" ")} ${staleNote} Не се допълва с дубликати или измислени записи.`.replace(/\s+/g, " ").trim()
      : sel.notes.length
        ? sel.notes.join(" ")
        : null;
  await t.dailyBatch.update({ where: { id: batch.id }, data: { shortfallReason: shortfall, quotaPlan: JSON.stringify(sel.plan) } });

  if (!existing) await enqueueDailyNotifications(t, { batchId: batch.id, localDate, total, target, scheduledAt, publishedAt: now });
  await audit(t, ctx.actor, existing ? "batch.topup" : "batch.publish", "DailyBatch", batch.id, { localDate, added: sel.picked.length, total, trigger: opts.trigger });
  return { batchId: batch.id, localDate, created: !existing, added: sel.picked.length, total, target, shortfallReason: shortfall };
}

/** Колко иначе нови кандидати са извън списъка само защото проверката им е по-стара от свежестта. */
async function staleCandidatesNote(t: DbLike, s: Settings, mode: string, now: Date): Promise<string> {
  const n = await t.business.count({
    where: {
      mergedIntoId: null,
      firstIssuedAt: null,
      batchItem: null,
      status: "ACTIVE",
      pipelineStage: "NEW",
      contactHistoryState: "NONE_CONFIRMED",
      reviewStatus: "NONE",
      verifiedAt: { lt: new Date(now.getTime() - s.reserveFreshnessDays * 86_400_000) },
      ...(mode === "real" ? { isDemo: false } : {}),
    },
  });
  return n > 0 ? `${n} кандидата са извън списъка, защото проверката им е по-стара от ${s.reserveFreshnessDays} дни (Настройки → свежест).` : "";
}

export function dailyMessage(total: number, target: number, followUps: number): { title: string; body: string } {
  // Без имена/телефони на клиенти в push payload.
  if (total === 0) return { title: "BDS LeadFlow", body: `Няма подготвени нови контакти днес. Последващи действия: ${followUps}.` };
  const head = total < target ? `Днешният списък е готов: ${total} от ${target} нови контакта (недостиг)` : `Днешният списък е готов: ${total} нови контакта`;
  return { title: "BDS LeadFlow", body: `${head} и ${followUps} последващи действия.` };
}

/** Outbox в същата транзакция като публикуването: един push запис (fan-out към устройства в worker-а) и един fallback имейл. */
export async function enqueueDailyNotifications(
  t: Tx,
  a: { batchId: string; localDate: string; total: number; target: number; scheduledAt: Date; publishedAt: Date },
) {
  const s = await getSettings(t);
  const fu = await dueFollowUpsCount(t, a.localDate);
  const msg = dailyMessage(a.total, a.target, fu);
  const payload = JSON.stringify({ ...msg, url: "/today" });
  if (s.notifications.pushEnabled) {
    const p = pushPayloadWithReceipt({ ...msg, url: "/today" });
    await t.notificationOutbox.upsert({
      where: { dedupeKey: `push:daily:${a.localDate}` },
      create: { dedupeKey: `push:daily:${a.localDate}`, channel: "PUSH", kind: "DAILY_READY", localDate: a.localDate, batchId: a.batchId, payload: p.payload, receiptTokenHash: p.receiptTokenHash, notBefore: a.publishedAt },
      update: {},
    });
  }
  if (s.notifications.emailFallbackEnabled) {
    const base = Math.max(a.scheduledAt.getTime(), a.publishedAt.getTime());
    await t.notificationOutbox.upsert({
      where: { dedupeKey: `email:fallback:${a.localDate}` },
      create: {
        dedupeKey: `email:fallback:${a.localDate}`,
        channel: "EMAIL",
        kind: "FALLBACK_EMAIL",
        localDate: a.localDate,
        batchId: a.batchId,
        payload,
        notBefore: new Date(base + s.notifications.fallbackDelayMinutes * 60_000),
      },
      update: {},
    });
  }
}

/** "Прегледай утре"/dry-run: какво БИ било избрано. Само четене — без reservation, без outbox. */
export async function previewSelection(db: DbLike, mode: Ctx["mode"], now: Date, localDate: string) {
  const s = await getSettings(db);
  const ectx = await buildEligibilityCtx(db, mode, s, now);
  const pool = await eligiblePool(db, ectx);
  const existing = await db.dailyBatch.findUnique({ where: { localDate }, include: { items: true } });
  const already: Record<string, number> = {};
  for (const it of existing?.items ?? []) already[it.bucket] = (already[it.bucket] ?? 0) + 1;
  const slots = Math.max(0, (existing?.target ?? s.dailyTarget) - (existing?.items.length ?? 0));
  const sel = selectWithQuotas(pool, s, slots, already);
  return {
    localDate,
    existingCount: existing?.items.length ?? 0,
    poolSize: pool.length,
    target: s.dailyTarget,
    notes: sel.notes,
    plan: sel.plan,
    items: sel.picked.map((p) => ({ id: p.c.b.id, ref: p.c.b.ref, name: p.c.b.name, city: p.c.b.city, bucket: p.bucket, score: p.c.score.score, reason: selectionReason(p.c) })),
  };
}

/** Подготовка преди публикуване: резерв от допустими кандидати (без reservation). */
export async function reserveStatus(db: DbLike, mode: Ctx["mode"], now: Date) {
  const s = await getSettings(db);
  const ectx = await buildEligibilityCtx(db, mode, s, now);
  const pool = await eligiblePool(db, ectx);
  const byCity: Record<string, number> = {};
  for (const c of pool) byCity[c.b.city] = (byCity[c.b.city] ?? 0) + 1;
  return { reserve: pool.length, reserveTarget: s.reserveTarget, byCity };
}

/** Издадени по-рано, но още без записан контакт → "Останали от предишни дни". Не са нови. */
export async function backlogItems(db: DbLike, localDate: string, opts: { realOnly?: boolean } = {}) {
  return db.dailyBatchItem.findMany({
    where: {
      batch: { localDate: { lt: localDate } },
      business: {
        ...(opts.realOnly ? { isDemo: false } : {}),
        status: "ACTIVE",
        pipelineStage: "NEW",
        mergedIntoId: null,
        activities: { none: { type: { in: CONTACT_ACTIVITY_TYPES } } },
        suppressions: { none: { liftedAt: null } },
      },
    },
    include: { batch: { select: { localDate: true } }, business: { include: { activities: { orderBy: { occurredAt: "desc" }, take: 1 }, audits: { orderBy: { checkedAt: "desc" }, take: 1 } } } },
    orderBy: [{ batch: { localDate: "asc" } }, { position: "asc" }],
  });
}

export async function batchForDate(db: PrismaClient | Tx, localDate: string) {
  return db.dailyBatch.findUnique({
    where: { localDate },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          business: {
            include: {
              activities: { orderBy: { occurredAt: "desc" }, take: 1 },
              suppressions: { where: { liftedAt: null } },
              audits: { orderBy: { checkedAt: "desc" }, take: 1 },
            },
          },
        },
      },
    },
  });
}
