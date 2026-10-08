import { z } from "zod";
import { audit, tx, type Ctx, type Tx } from "@/lib/db";
import { localDateOf } from "@/lib/time";
import { CATEGORIES, cents, idemKey, OFFER_STATUSES, STAGE_LABELS, STAGES, type Stage } from "./constants";
import { DomainError } from "./errors";
import { identifiersFor, normalizeDomain, normalizeName, normalizePhone, safeHttpUrl } from "./identity";
import { ingestCandidate } from "./ingest";
import { rescore } from "./rescore";

/* ---------------- Pipeline (ръчно преместване) ---------------- */

export const moveStageInput = z.object({ businessId: z.string(), toStage: z.enum(STAGES), reason: z.string().max(500).optional() });

export async function moveStage(ctx: Ctx, raw: z.input<typeof moveStageInput>) {
  const v = moveStageInput.parse(raw);
  return tx(ctx.db, async (t) => {
    const b = await t.business.findUnique({ where: { id: v.businessId } });
    if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
    const from = b.pipelineStage as Stage;
    if (from === v.toStage) return { stage: from };
    if (from === "WON") throw new DomainError("CONFLICT", "Спечелен клиент не се връща в pipeline. Управлявай го от „Клиенти“.");
    if (v.toStage === "WON") throw new DomainError("VALIDATION", "За „Спечелен“ използвай резултат „Спечелен клиент“ с данни за сделката.");
    if (v.toStage === "NEW") throw new DomainError("VALIDATION", "Връщане към „Нов“ не е позволено — историята не се нулира.");
    if (from === "LOST" && !v.reason?.trim()) throw new DomainError("VALIDATION", "Възстановяване от „Загубен“ изисква причина.");
    const now = ctx.clock.now();
    const act = await t.activity.create({ data: { businessId: b.id, type: "STATUS_CHANGE", note: `${STAGE_LABELS[from]} → ${STAGE_LABELS[v.toStage]}${v.reason ? `: ${v.reason}` : ""}`, occurredAt: now } });
    await t.pipelineHistory.create({ data: { businessId: b.id, fromStage: from, toStage: v.toStage, reason: v.reason ?? "Ръчно преместване", activityId: act.id, at: now } });
    await t.business.update({ where: { id: b.id }, data: { pipelineStage: v.toStage } });
    await audit(t, ctx.actor, "pipeline.move", "Business", b.id, { from, to: v.toStage });
    return { stage: v.toStage };
  });
}

/* ---------------- Бележки и срещи (не са обаждания) ---------------- */

export const activityInput = z.object({
  businessId: z.string(),
  type: z.enum(["NOTE", "MEETING"]),
  note: z.string().min(1).max(5000),
  occurredAt: z.coerce.date().optional(),
  idempotencyKey: idemKey,
});

export async function addActivity(ctx: Ctx, raw: z.input<typeof activityInput>) {
  const v = activityInput.parse(raw);
  const exists = await ctx.db.activity.findUnique({ where: { idempotencyKey: v.idempotencyKey } });
  if (exists) return exists;
  const b = await ctx.db.business.findUnique({ where: { id: v.businessId } });
  if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
  return tx(ctx.db, async (t) => {
    const a = await t.activity.create({ data: { businessId: v.businessId, type: v.type, note: v.note.trim(), occurredAt: v.occurredAt ?? ctx.clock.now(), idempotencyKey: v.idempotencyKey } });
    if (v.type === "MEETING") await t.business.update({ where: { id: v.businessId }, data: { contactHistoryState: "HAS_HISTORY", lastContactAt: a.occurredAt } });
    return a;
  });
}

/* ---------------- Follow-ups ---------------- */

export const followUpCreate = z.object({
  businessId: z.string(),
  dueAt: z.coerce.date(),
  reason: z.string().min(2).max(300),
  note: z.string().max(2000).optional(),
  kind: z.enum(["RETRY", "CALL_BACK", "OFFER", "NEXT_STEP", "GENERAL"]).default("GENERAL"),
  offerId: z.string().optional(),
});

async function assertNotDnc(t: Tx, businessId: string) {
  const n = await t.suppression.count({ where: { businessId, type: "DNC", liftedAt: null } });
  if (n > 0) throw new DomainError("DNC", "Контактът е с „Не се свързвай повече“ — действието е блокирано.");
}

export async function createFollowUp(ctx: Ctx, raw: z.input<typeof followUpCreate>) {
  const v = followUpCreate.parse(raw);
  return tx(ctx.db, async (t) => {
    await assertNotDnc(t, v.businessId);
    const f = await t.followUp.create({ data: { businessId: v.businessId, dueAt: v.dueAt, reason: v.reason, note: v.note, kind: v.kind, offerId: v.offerId } });
    await audit(t, ctx.actor, "followup.create", "FollowUp", f.id);
    return f;
  });
}

export async function completeFollowUp(ctx: Ctx, id: string, note?: string) {
  const f = await ctx.db.followUp.findUnique({ where: { id } });
  if (!f) throw new DomainError("NOT_FOUND", "Задачата не е намерена.");
  if (f.status !== "OPEN") return f;
  return ctx.db.followUp.update({ where: { id }, data: { status: "DONE", completedAt: ctx.clock.now(), note: note ? `${f.note ?? ""}\n${note}`.trim() : f.note } });
}

export async function rescheduleFollowUp(ctx: Ctx, id: string, dueAt: Date) {
  return tx(ctx.db, async (t) => {
    const f = await t.followUp.findUnique({ where: { id } });
    if (!f) throw new DomainError("NOT_FOUND", "Задачата не е намерена.");
    if (f.status !== "OPEN") throw new DomainError("CONFLICT", "Само отворени задачи могат да се пренасрочват.");
    await assertNotDnc(t, f.businessId);
    return t.followUp.update({ where: { id }, data: { dueAt } });
  });
}

/* ---------------- Оферти ---------------- */

export const offerInput = z.object({
  businessId: z.string(),
  service: z.string().min(2).max(200),
  oneTimeCents: cents,
  monthlyCents: cents.nullable().optional(),
  description: z.string().max(5000).default(""),
  offerDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  nextStep: z.string().max(500).nullable().optional(),
});

export async function createOffer(ctx: Ctx, raw: z.input<typeof offerInput>) {
  const v = offerInput.parse(raw);
  return tx(ctx.db, async (t) => {
    await assertNotDnc(t, v.businessId);
    const o = await t.offer.create({ data: { ...v, monthlyCents: v.monthlyCents ?? null, status: "DRAFT", createdAt: ctx.clock.now() } });
    await t.activity.create({ data: { businessId: v.businessId, type: "OFFER", note: `Чернова на оферта: ${v.service}`, occurredAt: ctx.clock.now() } });
    await audit(t, ctx.actor, "offer.create", "Offer", o.id);
    return o;
  });
}

export async function updateOffer(ctx: Ctx, id: string, raw: Partial<z.input<typeof offerInput>>) {
  const v = offerInput.partial().omit({ businessId: true }).parse(raw);
  const o = await ctx.db.offer.findUnique({ where: { id } });
  if (!o) throw new DomainError("NOT_FOUND", "Офертата не е намерена.");
  if (o.status !== "DRAFT" && o.status !== "SENT") throw new DomainError("CONFLICT", "Приключена оферта не се редактира.");
  return ctx.db.offer.update({ where: { id }, data: v });
}

export const offerStatusInput = z.object({ status: z.enum(OFFER_STATUSES), reason: z.string().max(500).optional() });

/**
 * „Маркирай като изпратена“ = аз съм я изпратил извън приложението. Приложението НЕ изпраща имейл.
 * ACCEPTED не създава клиент автоматично — WON изисква изрични данни за сделката (resultа „Спечелен клиент“).
 */
export async function setOfferStatus(ctx: Ctx, id: string, raw: z.input<typeof offerStatusInput>) {
  const v = offerStatusInput.parse(raw);
  return tx(ctx.db, async (t) => {
    const o = await t.offer.findUnique({ where: { id } });
    if (!o) throw new DomainError("NOT_FOUND", "Офертата не е намерена.");
    if (v.status === "SENT") {
      await assertNotDnc(t, o.businessId);
      if (o.status !== "DRAFT") throw new DomainError("CONFLICT", "Само чернова може да се маркира като изпратена.");
    }
    if (v.status === "DRAFT") throw new DomainError("VALIDATION", "Невалиден преход.");
    const now = ctx.clock.now();
    const u = await t.offer.update({
      where: { id },
      data: { status: v.status, ...(v.status === "SENT" ? { sentAt: now } : { decidedAt: now }) },
    });
    if (v.status === "SENT") {
      await t.followUp.updateMany({ where: { offerId: id, status: "OPEN", kind: "OFFER" }, data: { status: "DONE", completedAt: now } });
      await t.activity.create({ data: { businessId: o.businessId, type: "OFFER", note: `Офертата е маркирана като изпратена ръчно: ${o.service}`, occurredAt: now } });
      const b = await t.business.findUniqueOrThrow({ where: { id: o.businessId } });
      if (b.pipelineStage !== "WON" && b.pipelineStage !== "LOST" && b.pipelineStage !== "PROPOSAL") {
        await t.pipelineHistory.create({ data: { businessId: b.id, fromStage: b.pipelineStage, toStage: "PROPOSAL", reason: "Изпратена оферта", at: now } });
        await t.business.update({ where: { id: b.id }, data: { pipelineStage: "PROPOSAL" } });
      }
    }
    await audit(t, ctx.actor, "offer.status", "Offer", id, { status: v.status, reason: v.reason });
    return u;
  });
}

/* ---------------- Клиенти и ръчно получени плащания ---------------- */

export const paymentInput = z.object({
  clientId: z.string(),
  amountCents: cents.refine((n) => n > 0, "Сумата трябва да е положителна."),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).optional(),
  idempotencyKey: idemKey,
});

export async function recordPayment(ctx: Ctx, raw: z.input<typeof paymentInput>) {
  const v = paymentInput.parse(raw);
  const exists = await ctx.db.receivedPayment.findUnique({ where: { idempotencyKey: v.idempotencyKey } });
  if (exists) return exists;
  const c = await ctx.db.client.findUnique({ where: { id: v.clientId } });
  if (!c) throw new DomainError("NOT_FOUND", "Клиентът не е намерен.");
  const p = await ctx.db.receivedPayment.create({ data: v });
  await audit(ctx.db, ctx.actor, "payment.record", "Client", c.id, { amountCents: v.amountCents });
  return p;
}

export const clientUpdate = z.object({
  service: z.string().min(2).max(200).optional(),
  agreedOneTimeCents: cents.optional(),
  monthlyCents: cents.nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(["ACTIVE", "PAUSED", "ENDED"]).optional(),
  nextAction: z.string().max(500).nullable().optional(),
});

export async function updateClient(ctx: Ctx, id: string, raw: unknown) {
  const v = clientUpdate.parse(raw);
  const c = await ctx.db.client.findUnique({ where: { id } });
  if (!c) throw new DomainError("NOT_FOUND", "Клиентът не е намерен.");
  return ctx.db.client.update({ where: { id }, data: v });
}

/* ---------------- Ръчно добавяне, редакция, архив ---------------- */

export const manualLeadInput = z.object({
  name: z.string().min(2).max(200),
  city: z.string().min(2).max(60),
  category: z.enum(CATEGORIES.map((c) => c.key) as [string, ...string[]]),
  phone: z.string().max(40).optional(),
  website: z.string().max(300).optional(),
  socialUrl: z.string().max(300).optional(),
  address: z.string().max(300).optional(),
  notes: z.string().max(5000).optional(),
  contactHistoryState: z.enum(["NONE_CONFIRMED", "HAS_HISTORY", "UNKNOWN"]).default("UNKNOWN"),
  usageConfirmed: z.boolean().refine((x) => x, "Потвърди, че имаш право да използваш тези данни."),
  sourceNote: z.string().min(2).max(300),
});

export async function addManualLead(ctx: Ctx, raw: z.input<typeof manualLeadInput>) {
  const v = manualLeadInput.parse(raw);
  if (v.website && !safeHttpUrl(v.website)) throw new DomainError("VALIDATION", "Невалиден адрес на сайт (само http/https).");
  if (v.socialUrl && !safeHttpUrl(v.socialUrl)) throw new DomainError("VALIDATION", "Невалидна социална връзка (само http/https).");
  const now = ctx.clock.now();
  return tx(ctx.db, async (t) => {
    const r = await ingestCandidate(
      t,
      {
        name: v.name,
        city: v.city,
        category: v.category,
        phone: v.phone,
        website: v.website,
        socialUrl: v.socialUrl,
        address: v.address,
        notes: v.notes,
        source: "MANUAL",
        sourceRef: v.sourceNote,
        sourceUsageConfirmed: true,
        verifiedAt: now,
        contactHistoryState: v.contactHistoryState,
        isDemo: false,
      },
      now,
    );
    await rescore(t, now, [r.businessId]);
    await audit(t, ctx.actor, "lead.manual_add", "Business", r.businessId, { result: r.kind });
    return r;
  });
}

export const leadEditInput = z.object({
  name: z.string().min(2).max(200).optional(),
  legalName: z.string().max(200).nullable().optional(),
  city: z.string().min(2).max(60).optional(),
  address: z.string().max(300).nullable().optional(),
  category: z.string().optional(),
  phone: z.string().max(40).nullable().optional(),
  website: z.string().max(300).nullable().optional(),
  socialUrl: z.string().max(300).nullable().optional(),
  contactPersonName: z.string().max(120).nullable().optional(),
  contactPersonRole: z.string().max(120).nullable().optional(),
  openingLine: z.string().max(2000).nullable().optional(),
  questions: z.string().max(4000).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  suggestedService: z.string().max(200).nullable().optional(),
  estimatedValueCents: cents.nullable().optional(),
  nextAction: z.string().max(300).nullable().optional(),
});

/** Редакция. Старите идентификатори остават като aliases — промяна на име/телефон НЕ чисти историята. */
export async function editLead(ctx: Ctx, id: string, raw: unknown) {
  const v = leadEditInput.parse(raw);
  if (v.website && !safeHttpUrl(v.website)) throw new DomainError("VALIDATION", "Невалиден адрес на сайт (само http/https).");
  if (v.socialUrl && !safeHttpUrl(v.socialUrl)) throw new DomainError("VALIDATION", "Невалидна социална връзка (само http/https).");
  return tx(ctx.db, async (t) => {
    const b = await t.business.findUnique({ where: { id } });
    if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
    const data: Record<string, unknown> = { ...v };
    delete data.phone;
    delete data.website;
    if (v.name) data.normalizedName = normalizeName(v.name);
    if (v.phone !== undefined) {
      const ph = normalizePhone(v.phone);
      Object.assign(data, { phoneRaw: ph?.raw ?? null, phoneNormalized: ph?.normalized ?? null, phoneKind: ph?.kind ?? null, phoneVerified: false });
    }
    if (v.website !== undefined) {
      const w = safeHttpUrl(v.website);
      Object.assign(data, { website: w, websiteDomain: normalizeDomain(w) });
    }
    if (v.socialUrl !== undefined) data.socialUrl = safeHttpUrl(v.socialUrl);
    const u = await t.business.update({ where: { id }, data });
    for (const i of identifiersFor({ name: u.name, city: u.city, phone: u.phoneRaw, website: u.website, eik: u.eik })) {
      await t.businessIdentifier.upsert({
        where: { businessId_type_value: { businessId: id, type: i.type, value: i.value } },
        create: { businessId: id, type: i.type, value: i.value, isPrimary: i.strong },
        update: {},
      });
    }
    // Нов идентификатор на вече DNC бизнес също се потиска.
    const dnc = await t.suppression.findFirst({ where: { businessId: id, type: "DNC", liftedAt: null } });
    if (dnc) {
      const ids = await t.businessIdentifier.findMany({ where: { businessId: id, type: { in: ["PHONE", "DEMO_PHONE", "DOMAIN", "EIK", "PLACE_ID"] } } });
      for (const i of ids) {
        const has = await t.suppression.findFirst({ where: { type: "DNC", identifierType: i.type, identifierValue: i.value, liftedAt: null } });
        if (!has) await t.suppression.create({ data: { type: "DNC", businessId: id, identifierType: i.type, identifierValue: i.value, reason: dnc.reason } });
      }
    }
    await rescore(t, ctx.clock.now(), [id]);
    await audit(t, ctx.actor, "lead.edit", "Business", id, { fields: Object.keys(v) });
    return u;
  });
}

export async function archiveLead(ctx: Ctx, id: string, reason: string, restore = false) {
  if (!restore && reason.trim().length < 3) throw new DomainError("VALIDATION", "Посочи причина за архивиране.");
  return tx(ctx.db, async (t) => {
    const b = await t.business.findUnique({ where: { id } });
    if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
    // Архивирането/възстановяването НЕ нулира first_issued_at, история или потискания.
    const u = await t.business.update({
      where: { id },
      data: restore ? { status: "ACTIVE", archivedAt: null, archivedReason: null } : { status: "ARCHIVED", archivedAt: ctx.clock.now(), archivedReason: reason.trim() },
    });
    await audit(t, ctx.actor, restore ? "lead.restore" : "lead.archive", "Business", id, { reason });
    return u;
  });
}

/** Потвърждение на история (напр. след импорт) — само owner, с audit. */
export async function confirmHistory(ctx: Ctx, id: string, state: "NONE_CONFIRMED" | "HAS_HISTORY", reason: string) {
  return tx(ctx.db, async (t) => {
    const b = await t.business.findUnique({ where: { id }, include: { _count: { select: { activities: { where: { type: { in: ["CALL", "CONTACT_OTHER", "MEETING", "IMPORTED_HISTORY"] } } } } } } });
    if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
    if (state === "NONE_CONFIRMED" && (b._count.activities > 0 || b.firstIssuedAt)) {
      throw new DomainError("CONFLICT", "Има записан контакт или издаване — не може да се маркира като неконтактуван.");
    }
    // Потвърждението от owner-а е и проверка на данните (verified_at) — с audit.
    await t.business.update({ where: { id }, data: { contactHistoryState: state, verifiedAt: ctx.clock.now(), sourceUsageConfirmed: true } });
    await audit(t, ctx.actor, "lead.confirm_history", "Business", id, { state, reason });
  });
}

/* ---------------- Дубликати и сливане ---------------- */

const STRICT_HISTORY: Record<string, number> = { NONE_CONFIRMED: 0, UNKNOWN: 1, HAS_HISTORY: 2 };

/**
 * Transactional merge: пази най-ранните issued/contact дати, всички aliases и дейности,
 * и най-строгото потискане. Сливаният запис остава (mergedIntoId) за проследимост.
 */
export async function mergeBusinesses(ctx: Ctx, keepId: string, mergeId: string, reason: string) {
  if (keepId === mergeId) throw new DomainError("VALIDATION", "Не може да слееш запис със себе си.");
  return tx(ctx.db, async (t) => {
    const [keep, other] = await Promise.all([t.business.findUnique({ where: { id: keepId } }), t.business.findUnique({ where: { id: mergeId } })]);
    if (!keep || !other) throw new DomainError("NOT_FOUND", "Записът не е намерен.");
    if (keep.mergedIntoId || other.mergedIntoId) throw new DomainError("MERGED", "Единият запис вече е слят.");
    const otherIds = await t.businessIdentifier.findMany({ where: { businessId: mergeId } });
    for (const i of otherIds) {
      await t.businessIdentifier.upsert({
        where: { businessId_type_value: { businessId: keepId, type: i.type, value: i.value } },
        create: { businessId: keepId, type: i.type, value: i.value, isPrimary: false },
        update: {},
      });
    }
    await t.activity.updateMany({ where: { businessId: mergeId }, data: { businessId: keepId } });
    await t.followUp.updateMany({ where: { businessId: mergeId }, data: { businessId: keepId } });
    await t.offer.updateMany({ where: { businessId: mergeId }, data: { businessId: keepId } });
    await t.pipelineHistory.updateMany({ where: { businessId: mergeId }, data: { businessId: keepId } });
    const sups = await t.suppression.findMany({ where: { businessId: mergeId, liftedAt: null } });
    for (const s of sups) {
      await t.suppression.create({ data: { type: s.type, businessId: keepId, identifierType: s.identifierType, identifierValue: s.identifierValue, reason: `${s.reason} (от слят ${other.ref})` } });
    }
    const min = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
    const max = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
    const history = STRICT_HISTORY[other.contactHistoryState]! > STRICT_HISTORY[keep.contactHistoryState]! ? other.contactHistoryState : keep.contactHistoryState;
    const stageRank = { NEW: 0, CONTACTED: 1, QUALIFIED: 2, PROPOSAL: 3, LOST: 4, WON: 5 } as Record<string, number>;
    const stage = stageRank[other.pipelineStage]! > stageRank[keep.pipelineStage]! ? other.pipelineStage : keep.pipelineStage;
    await t.business.update({
      where: { id: keepId },
      data: {
        firstIssuedAt: min(keep.firstIssuedAt, other.firstIssuedAt),
        lastContactAt: max(keep.lastContactAt, other.lastContactAt),
        contactHistoryState: history,
        pipelineStage: stage,
        reviewStatus: "NONE",
        reviewReason: null,
        notes: [keep.notes, other.notes ? `[от ${other.ref}] ${other.notes}` : null].filter(Boolean).join("\n") || null,
      },
    });
    await t.business.update({ where: { id: mergeId }, data: { mergedIntoId: keepId, status: "ARCHIVED", archivedReason: `Слят в ${keep.ref}`, archivedAt: ctx.clock.now() } });
    await t.duplicateCandidate.updateMany({
      where: { OR: [{ businessAId: mergeId }, { businessBId: mergeId }] },
      data: { status: "MERGED", resolvedAt: ctx.clock.now() },
    });
    await audit(t, ctx.actor, "lead.merge", "Business", keepId, { merged: mergeId, reason });
    return { keepId };
  });
}

/** „Различни бизнеси“ — review приключва, но общият телефон/домейн продължава консервативно да изключва, ако другият е контактуван/DNC. */
export async function resolveDistinct(ctx: Ctx, businessId: string, reason: string) {
  return tx(ctx.db, async (t) => {
    await t.duplicateCandidate.updateMany({ where: { OR: [{ businessAId: businessId }, { businessBId: businessId }], status: "OPEN" }, data: { status: "DISTINCT", resolvedAt: ctx.clock.now() } });
    const b = await t.business.findUniqueOrThrow({ where: { id: businessId } });
    if (b.reviewStatus === "DUPLICATE_REVIEW") await t.business.update({ where: { id: businessId }, data: { reviewStatus: "NONE", reviewReason: null } });
    await audit(t, ctx.actor, "lead.distinct", "Business", businessId, { reason });
  });
}

export async function acknowledgeToday(ctx: Ctx, via: string) {
  const localDate = localDateOf(ctx.clock.now());
  const batch = await ctx.db.dailyBatch.findUnique({ where: { localDate } });
  if (!batch) return null;
  return ctx.db.dailyAcknowledgement.upsert({ where: { localDate }, create: { localDate, via, at: ctx.clock.now() }, update: {} });
}
