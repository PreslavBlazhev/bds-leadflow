import { z } from "zod";
import { audit, isUniqueViolation, lockBusinessRow, tx, type Ctx, type Tx } from "@/lib/db";
import { localDateOf } from "@/lib/time";
import { cents, idemKey, OUTCOME_LABELS, OUTCOMES, STAGE_RANK, type Outcome, type Stage } from "./constants";
import { DomainError } from "./errors";
import { getSettings } from "./settings";
import { noAnswerRetryAt } from "./activeList";

/**
 * Записване на резултат от разговор — един път за UI, тестове и импорти.
 * Outcome ≠ pipeline stage. callConnected е отделен флаг. Само channel=PHONE създава CALL activity
 * (броя се като опит); извънтелефонен контакт е CONTACT_OTHER и не увеличава call count.
 * Idempotency: activity.idempotencyKey е UNIQUE — повторен submit връща първия резултат без нови side effects.
 */
export const outcomeInput = z
  .object({
    businessId: z.string().min(1),
    outcome: z.enum(OUTCOMES),
    channel: z.enum(["PHONE", "OTHER"]).default("PHONE"),
    callConnected: z.boolean().optional(),
    note: z.string().max(5000).optional(),
    idempotencyKey: idemKey,
    callbackAt: z.coerce.date().optional(),
    retryAt: z.coerce.date().optional(),
    nextStepAt: z.coerce.date().optional(),
    declineReason: z.string().max(500).optional(),
    invalidPhoneNote: z.string().max(500).optional(),
    deal: z
      .object({
        service: z.string().min(2).max(200),
        oneTimeCents: cents,
        monthlyCents: cents.nullable().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        offerId: z.string().optional(),
      })
      .optional(),
    offerDraft: z
      .object({ packageKey: z.string().optional(), service: z.string().max(200).optional(), oneTimeCents: cents.optional(), monthlyCents: cents.nullable().optional() })
      .optional(),
  })
  .superRefine((v, c) => {
    if (v.outcome === "CALL_BACK") {
      if (!v.callbackAt) c.addIssue({ code: "custom", path: ["callbackAt"], message: "„Да се обадя отново“ изисква дата и час." });
      if (v.callConnected === undefined) c.addIssue({ code: "custom", path: ["callConnected"], message: "Посочи дали е имало разговор." });
    }
    if (v.outcome === "DO_NOT_CONTACT" && v.callConnected === undefined) {
      c.addIssue({ code: "custom", path: ["callConnected"], message: "Посочи дали е имало разговор." });
    }
    if (v.outcome === "WON" && !v.deal) c.addIssue({ code: "custom", path: ["deal"], message: "„Спечелен клиент“ изисква услуга, сума и начална дата." });
    if (v.outcome === "DECLINED" && !v.declineReason?.trim()) c.addIssue({ code: "custom", path: ["declineReason"], message: "Посочи причина за отказа." });
  });

export type OutcomeInput = z.input<typeof outcomeInput>;

const CONNECTED_DEFAULT: Record<Outcome, boolean | undefined> = {
  NO_ANSWER: false,
  SPOKE: true,
  CALL_BACK: undefined,
  INTERESTED: true,
  SEND_OFFER: true,
  WON: true,
  DECLINED: true,
  INVALID_NUMBER: false,
  DO_NOT_CONTACT: undefined,
};

/** Матрица: до кой етап води резултатът ("само напред"; WON/LOST са крайни). null = без промяна. */
export const OUTCOME_STAGE: Record<Outcome, Stage | null> = {
  NO_ANSWER: null,
  SPOKE: "CONTACTED",
  CALL_BACK: "CONTACTED", // само ако е имало разговор
  INTERESTED: "QUALIFIED",
  SEND_OFFER: "PROPOSAL",
  WON: "WON",
  DECLINED: "LOST",
  INVALID_NUMBER: null,
  DO_NOT_CONTACT: null, // DNC е отделен флаг, не е LOST
};

export function nextStage(current: Stage, outcome: Outcome, connected: boolean): Stage {
  if (current === "WON") return "WON"; // спечелен клиент никога не се връща назад от разговор
  const target = OUTCOME_STAGE[outcome];
  if (!target) return current;
  if (outcome === "CALL_BACK" && !connected) return current;
  if (target === "WON") return "WON";
  if (target === "LOST") return "LOST";
  if (current === "LOST") return current; // загубен се връща само с изрично ръчно действие
  return STAGE_RANK[target] > STAGE_RANK[current] ? target : current;
}

export interface OutcomeResult {
  activityId: string;
  duplicate: boolean;
  stage: string;
  followUpId?: string;
  /** „Не отговори“: действително планираната дата на повторното обаждане (ISO). */
  retryAt?: string;
  offerId?: string;
  clientId?: string;
}

/** Повторна заявка със същия ключ връща вече планираното повторно обаждане (без нова задача). */
async function retryOf(db: Tx | Ctx["db"], activityId: string) {
  const f = await db.followUp.findFirst({ where: { activityId, kind: "RETRY" }, select: { id: true, dueAt: true } });
  return f ? { followUpId: f.id, retryAt: f.dueAt.toISOString() } : {};
}

export async function recordOutcome(ctx: Ctx, raw: OutcomeInput): Promise<OutcomeResult> {
  const input = outcomeInput.parse(raw);
  try {
    return await tx(ctx.db, (t) => recordOutcomeTx(t, ctx, input));
  } catch (e) {
    if (isUniqueViolation(e)) {
      const prev = await ctx.db.activity.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { business: true } });
      if (prev) return { activityId: prev.id, duplicate: true, stage: prev.business.pipelineStage, ...(await retryOf(ctx.db, prev.id)) };
    }
    throw e;
  }
}

async function recordOutcomeTx(t: Tx, ctx: Ctx, input: z.infer<typeof outcomeInput>): Promise<OutcomeResult> {
  // Два различни записа за един бизнес едновременно (два таба/устройства) се редят: затварянето на старото
  // повторно обаждане и създаването на новото виждат едно и също състояние (PostgreSQL READ COMMITTED).
  await lockBusinessRow(t, input.businessId);
  const prev = await t.activity.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { business: true } });
  if (prev) return { activityId: prev.id, duplicate: true, stage: prev.business.pipelineStage, ...(await retryOf(t, prev.id)) };

  const b = await t.business.findUnique({ where: { id: input.businessId }, include: { suppressions: { where: { liftedAt: null } } } });
  if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
  if (b.mergedIntoId) throw new DomainError("MERGED", "Записът е слят — работи с каноничния.");
  const dnc = b.suppressions.some((s) => s.type === "DNC");
  if (dnc && input.outcome !== "DO_NOT_CONTACT") {
    throw new DomainError("DNC", "Контактът е с „Не се свързвай повече“. Обажданията са блокирани.");
  }
  const now = ctx.clock.now();
  const connected = input.callConnected ?? CONNECTED_DEFAULT[input.outcome] ?? false;
  const isPhone = input.channel === "PHONE";

  const activity = await t.activity.create({
    data: {
      businessId: b.id,
      type: isPhone ? "CALL" : "CONTACT_OTHER",
      outcome: input.outcome,
      callConnected: isPhone ? connected : null,
      note: input.note?.trim() || null,
      occurredAt: now,
      idempotencyKey: input.idempotencyKey,
    },
  });

  // Участието в списък става обработено (устойчиво) с първия успешно записан резултат; по-късни промени не го връщат.
  await t.dailyBatchItem.updateMany({ where: { businessId: b.id, processedAt: null }, data: { processedAt: now, processedOutcome: input.outcome, processedActivityId: activity.id } });
  // Направен опит → отворените повторни обаждания са изпълнени (историята на задачите остава).
  await t.followUp.updateMany({
    where: { businessId: b.id, status: "OPEN", kind: "RETRY" },
    data: { status: "DONE", completedAt: now, note: `Опитът е направен: ${OUTCOME_LABELS[input.outcome]}` },
  });

  const from = b.pipelineStage as Stage;
  const to = nextStage(from, input.outcome, connected);
  const result: OutcomeResult = { activityId: activity.id, duplicate: false, stage: to };
  const s = await getSettings(t);

  switch (input.outcome) {
    case "NO_ANSWER": {
      // Автоматично повторно обаждане след N работни дни; изрично избраната дата има предимство.
      const due = input.retryAt ?? noAnswerRetryAt(now, s);
      const f = await t.followUp.create({
        data: {
          businessId: b.id,
          activityId: activity.id,
          kind: "RETRY",
          dueAt: due,
          reason: input.retryAt ? "Повторно обаждане — не отговори (избрана дата)" : `Повторно обаждане — не отговори (след ${s.noAnswerRetryWorkdays} работни дни)`,
        },
      });
      result.followUpId = f.id;
      result.retryAt = due.toISOString();
      break;
    }
    case "CALL_BACK": {
      const f = await t.followUp.create({
        data: { businessId: b.id, activityId: activity.id, kind: "CALL_BACK", dueAt: input.callbackAt!, reason: "Да се обадя отново", note: input.note?.trim() || null },
      });
      result.followUpId = f.id;
      break;
    }
    case "INTERESTED":
      if (input.nextStepAt) {
        const f = await t.followUp.create({ data: { businessId: b.id, activityId: activity.id, kind: "NEXT_STEP", dueAt: input.nextStepAt, reason: "Следваща стъпка след интерес" } });
        result.followUpId = f.id;
      }
      break;
    case "SEND_OFFER": {
      const pkg = s.packages.find((p) => p.key === input.offerDraft?.packageKey) ?? s.packages[0];
      const offer = await t.offer.create({
        data: {
          businessId: b.id,
          service: input.offerDraft?.service || pkg?.label || "Уеб сайт",
          oneTimeCents: input.offerDraft?.oneTimeCents ?? pkg?.oneTimeCents ?? 0,
          monthlyCents: input.offerDraft?.monthlyCents ?? pkg?.monthlyCents ?? null,
          description: "Чернова, създадена от резултат „Изпрати оферта“. Прегледай преди изпращане.",
          offerDate: localDateOf(now),
          status: "DRAFT",
          createdAt: now, // часовникът на приложението (demo ден / тестове), не системният
          nextStep: "Подготви и изпрати офертата ръчно, после я маркирай като изпратена.",
        },
      });
      const f = await t.followUp.create({
        data: { businessId: b.id, activityId: activity.id, offerId: offer.id, kind: "OFFER", dueAt: input.nextStepAt ?? new Date(now.getTime() + 86_400_000), reason: "Изпрати офертата" },
      });
      result.offerId = offer.id;
      result.followUpId = f.id;
      break;
    }
    case "WON": {
      const d = input.deal!;
      if (d.offerId) {
        await t.offer.updateMany({ where: { id: d.offerId, businessId: b.id, status: { in: ["DRAFT", "SENT"] } }, data: { status: "ACCEPTED", decidedAt: now } });
      }
      // Idempotent: един Client на бизнес (businessId UNIQUE). Не е получено плащане.
      const client = await t.client.upsert({
        where: { businessId: b.id },
        create: {
          businessId: b.id,
          offerId: d.offerId ?? null,
          service: d.service,
          agreedOneTimeCents: d.oneTimeCents,
          monthlyCents: d.monthlyCents ?? null,
          startDate: d.startDate,
          status: "ACTIVE",
          nextAction: "Стартиране на проекта",
          createdAt: now,
        },
        update: {},
      });
      result.clientId = client.id;
      break;
    }
    case "DECLINED":
      await t.followUp.updateMany({ where: { businessId: b.id, status: "OPEN" }, data: { status: "CANCELLED", cancelledReason: "Отказ" } });
      break;
    case "INVALID_NUMBER":
      if (b.phoneNormalized) {
        await t.suppression.create({
          data: { type: "INVALID_PHONE", businessId: b.id, identifierType: b.phoneKind === "DEMO_SYNTHETIC" ? "DEMO_PHONE" : "PHONE", identifierValue: b.phoneNormalized, reason: input.invalidPhoneNote || "Невалиден номер (резултат от обаждане)" },
        });
      }
      await t.followUp.updateMany({ where: { businessId: b.id, status: "OPEN", kind: { in: ["RETRY", "CALL_BACK"] } }, data: { status: "CANCELLED", cancelledReason: "Невалиден номер" } });
      await t.business.update({ where: { id: b.id }, data: { reviewStatus: "NEEDS_CHECK", reviewReason: "Невалиден номер — нужен е проверен телефон" } });
      break;
    case "DO_NOT_CONTACT":
      await applyDnc(t, ctx, b.id, input.note?.trim() || "Поискано от контакта");
      break;
    case "SPOKE":
      break;
  }

  if (from !== to) {
    await t.pipelineHistory.create({ data: { businessId: b.id, fromStage: from, toStage: to, reason: `Резултат: ${OUTCOME_LABELS[input.outcome]}${input.declineReason ? ` — ${input.declineReason}` : ""}`, activityId: activity.id, at: now } });
  }
  await t.business.update({
    where: { id: b.id },
    data: {
      pipelineStage: to,
      lastOutcome: input.outcome,
      lastContactAt: now,
      contactHistoryState: "HAS_HISTORY",
      ...(input.outcome === "DECLINED" ? { nextAction: null, nextActionAt: null } : {}),
    },
  });
  await audit(t, ctx.actor, "outcome.record", "Business", b.id, { outcome: input.outcome, channel: input.channel, connected, from, to });
  return result;
}

/** DNC: глобално потискане на бизнеса и всички познати силни идентификатори; отмяна на предстоящи действия. */
export async function applyDnc(t: Tx, ctx: Pick<Ctx, "actor">, businessId: string, reason: string) {
  const ids = await t.businessIdentifier.findMany({ where: { businessId, type: { in: ["PHONE", "DEMO_PHONE", "DOMAIN", "EIK", "PLACE_ID"] } } });
  await t.suppression.create({ data: { type: "DNC", businessId, reason } });
  for (const i of ids) {
    await t.suppression.create({ data: { type: "DNC", businessId, identifierType: i.type, identifierValue: i.value, reason } });
  }
  await t.followUp.updateMany({ where: { businessId, status: "OPEN" }, data: { status: "CANCELLED", cancelledReason: "DNC — не се свързвай" } });
  await t.business.update({ where: { id: businessId }, data: { nextAction: null, nextActionAt: null } });
  await audit(t, ctx.actor, "dnc.apply", "Business", businessId, { reason });
}

/** Премахване на DNC — само изрично owner действие с причина и audit. НЕ прави записа „нов“. */
export async function liftDnc(ctx: Ctx, businessId: string, reason: string) {
  if (reason.trim().length < 5) throw new DomainError("VALIDATION", "Нужна е причина (поне 5 символа).");
  return tx(ctx.db, async (t) => {
    const n = await t.suppression.updateMany({ where: { businessId, type: "DNC", liftedAt: null }, data: { liftedAt: ctx.clock.now(), liftedReason: reason.trim() } });
    if (n.count === 0) throw new DomainError("NOT_FOUND", "Няма активно DNC.");
    await audit(t, ctx.actor, "dnc.lift", "Business", businessId, { reason: reason.trim() });
    return n.count;
  });
}

/** Отваряне на tel: — само намерение. Не е опит, не е разговор, не променя етапа. */
export async function recordDialIntent(ctx: Ctx, businessId: string, idempotencyKey: string) {
  const b = await ctx.db.business.findUnique({ where: { id: businessId }, include: { suppressions: { where: { liftedAt: null } } } });
  if (!b) throw new DomainError("NOT_FOUND", "Контактът не е намерен.");
  if (b.suppressions.length > 0) throw new DomainError("DNC", "Набирането е блокирано (DNC/невалиден номер).");
  // По записа, не по режима: реални записи в demo база (реален източник) могат да се набират; синтетичните — никога.
  if (b.isDemo || b.phoneKind !== "E164") throw new DomainError("DEMO", "Синтетичен demo номер или невалиден номер — няма реално набиране.");
  try {
    await ctx.db.activity.create({ data: { businessId, type: "DIAL_INTENT", occurredAt: ctx.clock.now(), idempotencyKey } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  return { tel: `tel:${b.phoneNormalized}` };
}
