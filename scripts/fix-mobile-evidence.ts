import { scriptCtx, run } from "./_ctx";
import { audit } from "../src/lib/db";
import { rescore } from "../src/domain/rescore";

/**
 * Корекция на СИНТЕТИЧНИ проверки на сайтове: „потвърдено лошо мобилно представяне“ е било извеждано
 * само от липсващ viewport таг, което не е доказателство. Махаме флага (poorMobile → неизвестно),
 * добавяме обяснение и преизчисляваме кеша на score. Не пипа история, издадени списъци, score snapshots
 * при издаване, резултати или реални (несинтетични) проверки. Idempotent.
 */
run(async () => {
  const ctx = await scriptCtx("fix-mobile-evidence");
  const MARK = "Мобилният вид не е проверен на телефон";
  const rows = await ctx.db.websiteAudit.findMany({ where: { synthetic: true, poorMobile: true, NOT: { evidence: { contains: "ръчно отваряне на телефон" } } } });
  for (const a of rows) {
    await ctx.db.websiteAudit.update({
      where: { id: a.id },
      data: { poorMobile: null, evidence: a.evidence.includes(MARK) ? a.evidence : `${a.evidence} ${MARK} — липсващият viewport таг сам по себе си не е доказателство.` },
    });
  }
  const n = await rescore(ctx.db, ctx.clock.now());
  await audit(ctx.db, "cli", "data.fix_mobile_evidence", undefined, undefined, { audits: rows.length });
  console.log(`[fix] Коригирани синтетични проверки: ${rows.length}. Преизчислени score кешове: ${n}.`);
  await ctx.db.$disconnect();
});
