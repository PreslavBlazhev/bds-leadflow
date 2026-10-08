import type { DbLike } from "@/lib/db";
import { candidateInclude, scoreFactsOf, type CandidateRow } from "./eligibility";
import { scoreBusiness } from "./scoring";
import { getSettings } from "./settings";

/** Преизчислява кеш колоната Business.score (за филтри/сортиране). Разбивката се изчислява наново при показване. */
export async function rescore(db: DbLike, now: Date, ids?: string[]) {
  const s = await getSettings(db);
  const rows = (await db.business.findMany({ where: { mergedIntoId: null, ...(ids ? { id: { in: ids } } : {}) }, include: candidateInclude })) as CandidateRow[];
  for (const b of rows) {
    const r = scoreBusiness(scoreFactsOf(b), s);
    if (b.score !== r.score) await db.business.update({ where: { id: b.id }, data: { score: r.score, scoreAt: now } });
  }
  return rows.length;
}
