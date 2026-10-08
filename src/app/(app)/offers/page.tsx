import Link from "next/link";
import { OfferEditor, OfferStatusActions } from "@/components/client/OfferTools";
import { Badge, Empty, money, PageHeader, StateBadge, Tabs } from "@/components/ui";
import { OFFER_STATUS_LABELS, OFFER_STATUSES, type OfferStatus } from "@/domain/constants";
import { getSettings } from "@/domain/settings";
import { requirePageOwner } from "@/lib/server";
import { addDays, fmtDate, fmtDateTime, localDateOf } from "@/lib/time";

export const metadata = { title: "Оферти" };

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ status?: string; new?: string; id?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/offers");
  const today = localDateOf(ctx.clock.now());
  const status = sp.status && (OFFER_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const [settings, offers, counts, newBiz, candidates] = await Promise.all([
    getSettings(ctx.db),
    ctx.db.offer.findMany({ where: status ? { status } : {}, orderBy: { updatedAt: "desc" }, take: 200, include: { business: { select: { id: true, name: true, city: true, suppressions: { where: { liftedAt: null, type: "DNC" }, select: { id: true } } } } } }),
    ctx.db.offer.groupBy({ by: ["status"], _count: true, _sum: { oneTimeCents: true, monthlyCents: true } }),
    sp.new ? ctx.db.business.findUnique({ where: { id: sp.new }, select: { id: true, name: true, suppressions: { where: { liftedAt: null, type: "DNC" } } } }) : null,
    ctx.db.business.findMany({ where: { pipelineStage: { in: ["CONTACTED", "QUALIFIED", "PROPOSAL"] }, mergedIntoId: null, suppressions: { none: { liftedAt: null, type: "DNC" } } }, select: { id: true, name: true, city: true }, orderBy: { name: "asc" }, take: 300 }),
  ]);
  const c = (s: string) => counts.find((x) => x.status === s);
  const estimated = await ctx.db.business.aggregate({ where: { pipelineStage: { in: ["QUALIFIED", "PROPOSAL"] }, mergedIntoId: null }, _sum: { estimatedValueCents: true } });
  const received = await ctx.db.receivedPayment.aggregate({ _sum: { amountCents: true } });

  return (
    <>
      <PageHeader title="Оферти" sub="Записи за оферти. Приложението НЕ изпраща оферти — „изпратена“ означава, че ти си я изпратил извън него." state={<StateBadge state="WORKING_LOCAL" />} />
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <div className="card p-2">
          <div className="text-xs text-muted">Прогнозна стойност (оценки, Квалифицирани+Оферта)</div>
          <div className="tabular font-semibold">{money(estimated._sum.estimatedValueCents ?? 0)}</div>
        </div>
        <div className="card p-2">
          <div className="text-xs text-muted">Изпратени оферти (еднократно)</div>
          <div className="tabular font-semibold">{money(c("SENT")?._sum.oneTimeCents ?? 0)}</div>
        </div>
        <div className="card p-2">
          <div className="text-xs text-muted">Приети оферти (≠ получени пари)</div>
          <div className="tabular font-semibold">{money(c("ACCEPTED")?._sum.oneTimeCents ?? 0)}</div>
        </div>
        <div className="card p-2">
          <div className="text-xs text-muted">Получени (ръчно записани)</div>
          <div className="tabular font-semibold">{money(received._sum.amountCents ?? 0)}</div>
        </div>
      </div>

      <section className="card mb-4 p-3" aria-labelledby="new-offer">
        <h2 id="new-offer" className="mb-2 text-base font-semibold">
          Нова оферта
        </h2>
        {newBiz && newBiz.suppressions.length > 0 ? (
          <p className="text-sm text-bad">„{newBiz.name}“ е с DNC — офертите са блокирани.</p>
        ) : (
          <OfferEditor
            businesses={newBiz ? [{ id: newBiz.id, name: newBiz.name, city: "" }, ...candidates.filter((x) => x.id !== newBiz.id)] : candidates}
            defaultBusinessId={newBiz?.id}
            packages={settings.packages}
            today={today}
            defaultValidUntil={addDays(today, 14)}
          />
        )}
      </section>

      <Tabs
        current={status ?? "all"}
        items={[{ key: "all", label: "Всички", href: "/offers" }, ...OFFER_STATUSES.map((s) => ({ key: s, label: OFFER_STATUS_LABELS[s], href: `/offers?status=${s}`, count: c(s)?._count ?? 0 }))]}
      />
      {offers.length === 0 ? (
        <Empty title="Няма оферти." />
      ) : (
        <ul className="space-y-2">
          {offers.map((o) => (
            <li key={o.id} id={o.id} className={`card p-3 ${sp.id === o.id ? "ring-1 ring-accent" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={o.status === "ACCEPTED" ? "ok" : o.status === "SENT" ? "info" : o.status === "DRAFT" ? "neutral" : "warn"}>{OFFER_STATUS_LABELS[o.status as OfferStatus]}</Badge>
                    {o.business.suppressions.length > 0 && <Badge tone="bad">■ DNC</Badge>}
                    <span className="font-medium">{o.service}</span>
                  </div>
                  <div className="text-sm">
                    <Link href={`/leads/${o.business.id}`}>{o.business.name}</Link> <span className="text-muted">· {o.business.city}</span>
                  </div>
                  <div className="tabular mt-1 text-sm">
                    Еднократно {money(o.oneTimeCents)} · Месечна поддръжка {o.monthlyCents !== null ? money(o.monthlyCents) : "—"}
                  </div>
                  <div className="text-xs text-muted">
                    Дата {fmtDate(o.offerDate)} · валидна до {fmtDate(o.validUntil)}
                    {o.sentAt && ` · маркирана като изпратена ${fmtDateTime(o.sentAt)}`}
                    {o.nextStep && ` · Следваща стъпка: ${o.nextStep}`}
                  </div>
                  {o.description && <p className="mt-1 text-sm whitespace-pre-wrap text-muted">{o.description}</p>}
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <OfferStatusActions id={o.id} status={o.status} dnc={o.business.suppressions.length > 0} />
                  <Link href={`/offers/${o.id}/print`} className="btn btn-sm">
                    Преглед за печат / копиране
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
