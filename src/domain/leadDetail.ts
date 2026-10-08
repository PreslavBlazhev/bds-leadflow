import type { PrismaClient } from "@prisma/client";
import type { Mode } from "@/lib/db";
import { buildEligibilityCtx, evaluateEligibility, scoreFactsOf, type CandidateRow } from "./eligibility";
import { templatePitch } from "./pitch";
import { scoreBusiness } from "./scoring";
import { getSettings } from "./settings";
import { CONTACT_ACTIVITY_TYPES } from "./constants";

export async function loadLeadDetail(db: PrismaClient, id: string, mode: Mode, now: Date) {
  const b = await db.business.findUnique({
    where: { id },
    include: {
      identifiers: { orderBy: { createdAt: "asc" } },
      evidence: { orderBy: { fetchedAt: "desc" } },
      audits: { orderBy: { checkedAt: "desc" } },
      reviews: true,
      scores: { orderBy: { computedAt: "desc" }, take: 1 },
      activities: { orderBy: { occurredAt: "desc" } },
      pipelineHistory: { orderBy: { at: "desc" } },
      batchItem: { include: { batch: { select: { localDate: true } } } },
      followUps: { orderBy: { dueAt: "asc" } },
      offers: { orderBy: { createdAt: "desc" } },
      client: true,
      suppressions: { orderBy: { createdAt: "desc" } },
      dupesA: { include: { businessB: { select: { id: true, ref: true, name: true } } } },
      dupesB: { include: { businessA: { select: { id: true, ref: true, name: true } } } },
      mergedInto: { select: { id: true, ref: true, name: true } },
      mergedChildren: { select: { id: true, ref: true, name: true } },
    },
  });
  if (!b) return null;
  const settings = await getSettings(db);
  const contactCount = b.activities.filter((a) => (CONTACT_ACTIVITY_TYPES as string[]).includes(a.type)).length;
  const row = { ...b, _count: { activities: contactCount } } as unknown as CandidateRow;
  const ectx = await buildEligibilityCtx(db, mode, settings, now);
  const eligibility = evaluateEligibility(row, ectx);
  const score = scoreBusiness(scoreFactsOf(row), settings);
  const pitch = templatePitch(b, b.audits[0] ?? null);
  const activeSup = b.suppressions.filter((s) => !s.liftedAt);
  const dnc = activeSup.some((s) => s.type === "DNC");
  const invalidPhone = activeSup.some((s) => s.type === "INVALID_PHONE");
  const dupes = [
    ...b.dupesA.map((d) => ({ id: d.id, status: d.status, matchType: d.matchType, other: d.businessB })),
    ...b.dupesB.map((d) => ({ id: d.id, status: d.status, matchType: d.matchType, other: d.businessA })),
  ];
  return { b, settings, eligibility, score, pitch, dnc, invalidPhone, dupes, contactCount };
}

export type LeadDetailData = NonNullable<Awaited<ReturnType<typeof loadLeadDetail>>>;
