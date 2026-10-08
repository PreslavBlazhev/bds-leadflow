import Link from "next/link";
import { MoveStage } from "@/components/client/MoveStage";
import { Badge, money, PageHeader, StateBadge } from "@/components/ui";
import { OUTCOME_LABELS, STAGE_LABELS, STAGES, type Outcome } from "@/domain/constants";
import { requirePageOwner } from "@/lib/server";

export const metadata = { title: "Pipeline" };
const LIMIT = 40;

export default async function PipelinePage() {
  const ctx = await requirePageOwner("/pipeline");
  const cols = await Promise.all(
    STAGES.map(async (stage) => {
      // „Нов“ тук = вече издаден/контактуван, но още в етап Нов. Неиздадените са в базата.
      const where = { pipelineStage: stage, mergedIntoId: null, status: "ACTIVE", ...(stage === "NEW" ? { firstIssuedAt: { not: null } } : {}) };
      const [count, rows] = await Promise.all([
        ctx.db.business.count({ where }),
        ctx.db.business.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          take: LIMIT,
          include: { offers: { orderBy: { createdAt: "desc" }, take: 1 }, suppressions: { where: { liftedAt: null, type: "DNC" } }, client: true },
        }),
      ]);
      return { stage, count, rows };
    }),
  );
  const offersAgg = await ctx.db.offer.groupBy({ by: ["status"], _sum: { oneTimeCents: true }, _count: true });
  const sum = (st: string) => offersAgg.find((o) => o.status === st);
  const clientsAgg = await ctx.db.client.aggregate({ _sum: { agreedOneTimeCents: true } });
  const received = await ctx.db.receivedPayment.aggregate({ _sum: { amountCents: true } });

  return (
    <>
      <PageHeader title="Pipeline" sub="Етапът е отделен от резултата от разговор. Преместване: падащо меню (drag-and-drop не е нужно)." state={ctx.mode === "demo" ? <StateBadge state="DEMO_SIMULATED" /> : <StateBadge state="WORKING_LOCAL" />} />
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <div className="card p-2">
          Чернови оферти: <strong className="tabular">{money(sum("DRAFT")?._sum.oneTimeCents ?? 0)}</strong> <span className="text-muted">({sum("DRAFT")?._count ?? 0})</span>
        </div>
        <div className="card p-2">
          Изпратени: <strong className="tabular">{money(sum("SENT")?._sum.oneTimeCents ?? 0)}</strong> <span className="text-muted">({sum("SENT")?._count ?? 0})</span>
        </div>
        <div className="card p-2">
          Договорено (клиенти): <strong className="tabular">{money(clientsAgg._sum.agreedOneTimeCents ?? 0)}</strong>
        </div>
        <div className="card p-2">
          Получено (ръчно записано): <strong className="tabular">{money(received._sum.amountCents ?? 0)}</strong>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {cols.map((c) => (
          <section key={c.stage} className="rounded-lg border border-line bg-panel p-2" aria-labelledby={`col-${c.stage}`}>
            <h2 id={`col-${c.stage}`} className="mb-2 flex justify-between px-1 text-sm font-semibold">
              {STAGE_LABELS[c.stage]} <span className="tabular text-muted">{c.count}</span>
            </h2>
            <ul className="space-y-2">
              {c.rows.map((b) => (
                <li key={b.id} className="card p-2 text-sm">
                  <Link href={`/leads/${b.id}`} className="font-medium text-fg">
                    {b.name}
                  </Link>
                  <div className="text-xs text-muted">
                    {b.city} · {b.lastOutcome ? OUTCOME_LABELS[b.lastOutcome as Outcome] : "без резултат"}
                  </div>
                  <div className="mt-1 text-xs">
                    {b.client ? (
                      <>Договорено: {money(b.client.agreedOneTimeCents)}</>
                    ) : b.offers[0] ? (
                      <>
                        Оферта: {money(b.offers[0].oneTimeCents)} ({b.offers[0].status})
                      </>
                    ) : (
                      <span className="text-muted">Прогноза: {money(b.estimatedValueCents)}</span>
                    )}
                  </div>
                  {b.suppressions.length > 0 && <Badge tone="bad">■ DNC</Badge>}
                  <MoveStage businessId={b.id} current={b.pipelineStage} />
                </li>
              ))}
              {c.count > LIMIT && (
                <li className="px-1 text-xs text-muted">
                  …и още {c.count - LIMIT}. <Link href={`/leads?tab=all&stage=${c.stage}`}>Виж всички</Link>
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
