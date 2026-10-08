import Link from "next/link";
import { FollowUpActions } from "@/components/client/FollowUpActions";
import { Badge, Empty, PageHeader, StateBadge, Tabs } from "@/components/ui";
import { FOLLOWUP_KIND_LABELS } from "@/domain/constants";
import { requirePageOwner } from "@/lib/server";
import { addDays, fmtDate, fmtDateTime, localDateOf, toLocalInput, zonedToUtc } from "@/lib/time";

export const metadata = { title: "Последващи" };

export default async function FollowUpsPage({ searchParams }: { searchParams: Promise<{ tab?: string; view?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/follow-ups");
  const now = ctx.clock.now();
  const today = localDateOf(now);
  const start = zonedToUtc(today, "00:00");
  const end = zonedToUtc(addDays(today, 1), "00:00");
  const tab = sp.tab ?? "today";
  const range = tab === "overdue" ? { lt: start } : tab === "today" ? { gte: start, lt: end } : tab === "upcoming" ? { gte: end } : undefined;
  const where = tab === "done" ? { status: { in: ["DONE", "CANCELLED"] } } : { status: "OPEN", dueAt: range };
  const [rows, cOver, cToday, cUp] = await Promise.all([
    ctx.db.followUp.findMany({
      where,
      orderBy: tab === "done" ? { dueAt: "desc" } : { dueAt: "asc" },
      take: 200,
      include: { business: { select: { id: true, name: true, city: true, ref: true } }, activity: { select: { outcome: true, occurredAt: true } }, offer: { select: { id: true, service: true, status: true } } },
    }),
    ctx.db.followUp.count({ where: { status: "OPEN", dueAt: { lt: start } } }),
    ctx.db.followUp.count({ where: { status: "OPEN", dueAt: { gte: start, lt: end } } }),
    ctx.db.followUp.count({ where: { status: "OPEN", dueAt: { gte: end } } }),
  ]);
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = localDateOf(r.dueAt);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const calendar = sp.view === "calendar" && tab === "upcoming";
  return (
    <>
      <PageHeader
        title="Последващи действия"
        sub="Не се включват в дневните нови. Отменените при DNC/отказ са в „Приключени“."
        state={<StateBadge state="WORKING_LOCAL" />}
        actions={
          tab === "upcoming" && (
            <Link href={calendar ? "/follow-ups?tab=upcoming" : "/follow-ups?tab=upcoming&view=calendar"} className="btn btn-sm">
              {calendar ? "Изглед списък" : "Изглед по дни"}
            </Link>
          )
        }
      />
      <Tabs
        current={tab}
        items={[
          { key: "overdue", label: "Просрочени", count: cOver },
          { key: "today", label: "Днес", count: cToday },
          { key: "upcoming", label: "Предстоящи", count: cUp },
          { key: "done", label: "Приключени" },
        ].map((t) => ({ ...t, href: `/follow-ups?tab=${t.key}` }))}
      />
      {rows.length === 0 ? (
        <Empty title="Няма задачи в този раздел." />
      ) : calendar ? (
        <div className="space-y-3">
          {[...byDay.entries()].map(([d, list]) => (
            <section key={d} className="card p-3">
              <h2 className="mb-1 text-sm font-semibold">{fmtDate(d)}</h2>
              <ul className="text-sm">
                {list.map((f) => (
                  <li key={f.id}>
                    {fmtDateTime(f.dueAt).slice(11)} — <Link href={`/leads/${f.business.id}`}>{f.business.name}</Link> · {f.reason}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((f) => (
            <li key={f.id} className="card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {f.status === "OPEN" && f.dueAt < start && <Badge tone="bad">■ Просрочено</Badge>}
                    {f.status !== "OPEN" && <Badge>{f.status === "DONE" ? "Приключено" : `Отменено: ${f.cancelledReason ?? ""}`}</Badge>}
                    <Badge tone="info">{FOLLOWUP_KIND_LABELS[f.kind]}</Badge>
                    <span className="tabular text-sm">{fmtDateTime(f.dueAt)}</span>
                  </div>
                  <div className="mt-1 font-medium">
                    <Link href={`/leads/${f.business.id}`}>{f.business.name}</Link> <span className="text-sm text-muted">· {f.business.city}</span>
                  </div>
                  <div className="text-sm">{f.reason}</div>
                  {f.note && <div className="text-sm whitespace-pre-wrap text-muted">{f.note}</div>}
                  <div className="text-xs text-muted">
                    {f.activity && `От дейност ${fmtDate(f.activity.occurredAt)}${f.activity.outcome ? ` (${f.activity.outcome})` : ""}`}
                    {f.offer && (
                      <>
                        {" "}
                        · Оферта: <Link href={`/offers?id=${f.offer.id}`}>{f.offer.service}</Link> ({f.offer.status})
                      </>
                    )}
                  </div>
                </div>
                {f.status === "OPEN" && <FollowUpActions id={f.id} businessId={f.business.id} defaultWhen={toLocalInput(new Date(Math.max(f.dueAt.getTime(), now.getTime()) + 86_400_000))} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
