import Link from "next/link";
import { CallSession, type QueueItem } from "@/components/client/CallSession";
import { PageHeader, StateBadge } from "@/components/ui";
import { buildCallQueues, QUEUE_KEYS, QUEUE_LABELS, type QueueKey, type QueueEntry } from "@/domain/callQueue";
import { CATEGORY_LABELS, OUTCOME_LABELS, type Outcome } from "@/domain/constants";
import { scoreFactsOf, type CandidateRow } from "@/domain/eligibility";
import { formatPhone } from "@/domain/identity";
import { templatePitch } from "@/domain/pitch";
import { humanReasons } from "@/domain/reasons";
import { RULE_LABELS, scoreBusiness } from "@/domain/scoring";
import { dataMode, getSettings } from "@/domain/settings";
import { noAnswerRetryAt, realOnlyFor } from "@/domain/activeList";
import { realStockSummary } from "@/domain/realStock";
import { toLocalInput } from "@/lib/time";
import { requirePageOwner } from "@/lib/server";
import { fmtDate } from "@/lib/time";

export const metadata = { title: "Обаждания" };

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ id?: string; queue?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/calls");
  const now = ctx.clock.now();
  const [settings, q] = await Promise.all([getSettings(ctx.db), buildCallQueues(ctx.db, now)]);

  // Избор на опашка: изрично ?queue=; при ?id= — опашката, в която е контактът; иначе „Нови днес“.
  let queueKey: QueueKey | "selected" = (QUEUE_KEYS as readonly string[]).includes(sp.queue ?? "") ? (sp.queue as QueueKey) : "new";
  if (sp.id && !sp.queue) {
    const found = QUEUE_KEYS.find((k) => q.queues[k].some((e) => e.businessId === sp.id));
    queueKey = found ?? "selected";
  }
  const entries: QueueEntry[] = queueKey === "selected" ? [{ businessId: sp.id!, note: "Избран контакт" }] : q.queues[queueKey];
  const startIndex = sp.id ? Math.max(0, entries.findIndex((e) => e.businessId === sp.id)) : 0;

  const businesses = await ctx.db.business.findMany({
    where: { id: { in: entries.map((e) => e.businessId) } },
    include: {
      audits: { orderBy: { checkedAt: "desc" } },
      identifiers: true,
      activities: { orderBy: { occurredAt: "desc" }, take: 3 },
      suppressions: { where: { liftedAt: null } },
      batchItem: { select: { id: true, issuedAt: true } },
      offers: { where: { status: { in: ["DRAFT", "SENT"] } } },
      _count: { select: { activities: true } },
    },
  });
  const byId = new Map(businesses.map((b) => [b.id, b]));
  const items: QueueItem[] = [];
  for (const e of entries) {
    const b = byId.get(e.businessId);
    if (!b) continue;
    const audit = b.audits[0] ?? null;
    const facts = scoreFactsOf(b as unknown as CandidateRow);
    const score = scoreBusiness(facts, settings);
    const pitch = templatePitch(b, audit);
    const dnc = b.suppressions.some((s) => s.type === "DNC");
    const invalid = b.suppressions.some((s) => s.type === "INVALID_PHONE");
    const issues: string[] = audit ? JSON.parse(audit.issues) : [];
    items.push({
      id: b.id,
      ref: b.ref,
      name: b.name,
      city: b.city,
      category: CATEGORY_LABELS[b.category] ?? b.category,
      phone: formatPhone(b.phoneNormalized, b.phoneKind),
      // По записа: реалните (импортирани) номера се набират и в demo база; синтетичните — никога.
      canDial: !b.isDemo && b.phoneKind === "E164" && !dnc && !invalid,
      dialReason: dnc ? "DNC — блокирано." : invalid ? "Номерът е маркиран като невалиден." : b.isDemo || b.phoneKind === "DEMO_SYNTHETIC" ? "Демо: синтетичен номер, без реално набиране." : b.phoneKind !== "E164" ? "Няма валиден номер." : null,
      blockedReason: dnc ? "Контактът е с „Не се свързвай повече“." : null,
      // Издаден контакт остава в списъка и след изтичане на свежестта — само предупреждение.
      queueNote: b.verifiedAt && now.getTime() - b.verifiedAt.getTime() > settings.reserveFreshnessDays * 86_400_000 ? `${e.note} · ▲ данните се нуждаят от нова проверка` : e.note,
      reasons: humanReasons(score, facts),
      details: [
        ...score.lines.filter((l) => l.applied).map((l) => `${RULE_LABELS[l.rule] ?? l.rule} (${l.points > 0 ? "+" : ""}${l.points}): ${l.why}`),
        ...(audit ? [`Проверка на сайта (${fmtDate(audit.checkedAt)}): ${issues.length ? issues.join("; ") : "без наблюдавани пропуски"}. ${audit.evidence}`] : ["Сайтът не е проверяван."]),
        `Score ${score.score}/100 — търговски приоритет, не оценка на платежоспособност.`,
      ],
      opening: pitch.opening,
      questions: pitch.questions,
      pitchIsTemplate: pitch.isTemplate,
      recent: b.activities.map((a) => `${fmtDate(a.occurredAt)} ${a.outcome ? OUTCOME_LABELS[a.outcome as Outcome] : a.type === "NOTE" ? "Бележка" : a.type}${a.note ? ` — ${a.note.slice(0, 80)}` : ""}`),
      openOffers: b.offers.map((x) => ({ id: x.id, service: x.service, oneTimeCents: x.oneTimeCents, monthlyCents: x.monthlyCents })),
    });
  }

  const counts: Record<QueueKey, number> = { new: q.queues.new.length, followups: q.queues.followups.length, backlog: q.queues.backlog.length };
  const realMode = realOnlyFor(ctx.mode, settings);
  // В реален режим „необработени от предишни дни“ няма — те са в активния списък до приключването му.
  const shownKeys = QUEUE_KEYS.filter((k) => !(realMode && k === "backlog"));
  const stock = realMode ? await realStockSummary(ctx.db, ctx.mode, now) : null;
  return (
    <>
      <PageHeader
        title="Обаждания"
        sub="Един контакт наведнъж. Резултатът го записваш ти — приложението не вижда обажданията в телефона."
        state={dataMode(ctx.mode, settings) === "demo" ? <StateBadge state="DEMO_SIMULATED" title="Симулирани обаждания — без tel: към синтетични номера" /> : <StateBadge state="WORKING_LOCAL" />}
      />
      <nav aria-label="Опашка" className="mb-3 flex flex-wrap gap-1.5">
        {shownKeys.map((k) => (
          <Link
            key={k}
            href={`/calls?queue=${k}`}
            aria-current={queueKey === k ? "page" : undefined}
            className={`btn btn-sm ${queueKey === k ? "border-accent bg-blue-950/40 text-fg" : ""}`}
          >
            {QUEUE_LABELS[k]} <span className="tabular rounded bg-bg px-1.5 text-xs">{counts[k]}</span>
          </Link>
        ))}
        {queueKey === "selected" && <span className="btn btn-sm border-accent">Избран контакт</span>}
        {stock && (
          <span className="inline-flex min-h-8 items-center rounded-lg border border-line px-2.5 text-xs text-muted" title="Допустими нови кандидати, още неиздадени">
            Запас: <strong className="tabular ml-1 text-fg">{stock.eligible}</strong>&nbsp;допустими нови
          </span>
        )}
      </nav>
      <CallSession
        key={`${queueKey}:${sp.id ?? ""}`}
        queueKey={queueKey}
        queueLabel={queueKey === "selected" ? "Избран контакт" : QUEUE_LABELS[queueKey]}
        queue={items}
        startIndex={startIndex}
        newProgress={queueKey === "new" ? q.newProgress : null}
        otherQueues={shownKeys.filter((k) => k !== queueKey && counts[k] > 0).map((k) => ({ key: k, label: QUEUE_LABELS[k], count: counts[k] }))}
        packages={settings.packages}
        today={q.today}
        mode={ctx.mode}
        callWindow={settings.callWindow}
        retryDefault={{ local: toLocalInput(noAnswerRetryAt(now, settings)), workdays: settings.noAnswerRetryWorkdays }}
      />
    </>
  );
}
