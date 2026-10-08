import Link from "next/link";
import { ClientEditor, PaymentForm } from "@/components/client/ClientTools";
import { Badge, Empty, money, PageHeader, StateBadge } from "@/components/ui";
import { requirePageOwner } from "@/lib/server";
import { fmtDate, localDateOf } from "@/lib/time";

export const metadata = { title: "Клиенти" };

export default async function ClientsPage() {
  const ctx = await requirePageOwner("/clients");
  const today = localDateOf(ctx.clock.now());
  const clients = await ctx.db.client.findMany({ orderBy: { createdAt: "desc" }, include: { business: { select: { id: true, name: true, city: true, phoneNormalized: true } }, payments: { orderBy: { receivedOn: "desc" } }, offer: { select: { service: true } } } });
  const agreed = clients.reduce((a, c) => a + c.agreedOneTimeCents, 0);
  const monthly = clients.filter((c) => c.status === "ACTIVE").reduce((a, c) => a + (c.monthlyCents ?? 0), 0);
  const received = clients.reduce((a, c) => a + c.payments.reduce((x, p) => x + p.amountCents, 0), 0);
  return (
    <>
      <PageHeader title="Клиенти" sub="Спечелени сделки. Оперативно проследяване — не е счетоводна или фактурираща система." state={<StateBadge state="WORKING_LOCAL" />} />
      <div className="mb-4 grid grid-cols-3 gap-2 text-sm">
        <div className="card p-2">
          <div className="text-xs text-muted">Договорено еднократно</div>
          <div className="tabular font-semibold">{money(agreed)}</div>
        </div>
        <div className="card p-2">
          <div className="text-xs text-muted">Месечна поддръжка (активни)</div>
          <div className="tabular font-semibold">{money(monthly)}</div>
        </div>
        <div className="card p-2">
          <div className="text-xs text-muted">Получено (ръчно записано)</div>
          <div className="tabular font-semibold">{money(received)}</div>
        </div>
      </div>
      {clients.length === 0 ? (
        <Empty title="Още няма спечелени клиенти.">Клиент се създава само чрез резултат „Спечелен клиент“ с данни за сделката.</Empty>
      ) : (
        <ul className="space-y-3">
          {clients.map((c) => {
            const paid = c.payments.reduce((x, p) => x + p.amountCents, 0);
            return (
              <li key={c.id} className="card p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/leads/${c.business.id}`} className="font-medium">
                        {c.business.name}
                      </Link>
                      <Badge tone={c.status === "ACTIVE" ? "ok" : c.status === "PAUSED" ? "warn" : "neutral"}>{c.status === "ACTIVE" ? "Активен" : c.status === "PAUSED" ? "Пауза" : "Приключил"}</Badge>
                    </div>
                    <div className="text-sm">{c.service}</div>
                    <div className="tabular text-sm">
                      Договорено {money(c.agreedOneTimeCents)} · месечно {c.monthlyCents !== null ? money(c.monthlyCents) : "—"} · получено <strong>{money(paid)}</strong>
                      {paid < c.agreedOneTimeCents && <span className="text-muted"> (остатък {money(c.agreedOneTimeCents - paid)})</span>}
                    </div>
                    <div className="text-xs text-muted">
                      Начало {fmtDate(c.startDate)} · край {fmtDate(c.endDate)} · следващо: {c.nextAction ?? "—"}
                    </div>
                    {c.payments.length > 0 && (
                      <ul className="mt-1 text-xs text-muted">
                        {c.payments.map((p) => (
                          <li key={p.id}>
                            {fmtDate(p.receivedOn)} — {money(p.amountCents)} {p.note && `· ${p.note}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 text-xs text-muted">Повторни продажби се водят тук — клиентът не се връща като нов prospect.</p>
                  </div>
                  <div className="w-full space-y-2 sm:w-80">
                    <PaymentForm clientId={c.id} today={today} />
                    <ClientEditor id={c.id} status={c.status} nextAction={c.nextAction ?? ""} endDate={c.endDate ?? ""} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
