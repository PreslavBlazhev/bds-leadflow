import { PilotList } from "@/components/client/PilotList";
import { Badge, Notice, PageHeader, StateBadge } from "@/components/ui";
import { CATEGORY_LABELS } from "@/domain/constants";
import { historyCoverage } from "@/domain/pilot";
import { getEnv } from "@/lib/env";
import { requirePageOwner } from "@/lib/server";
import { localDateOf } from "@/lib/time";
import { placesGate, SKU_DETAILS_ENTERPRISE } from "@/providers/googlePlaces";

export const metadata = { title: "Пилот: първи реални бизнеси" };

const STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "За преглед",
  APPROVED: "Одобрени за обаждане",
  REJECTED: "Отхвърлени",
  IN_HISTORY: "В моята история / DNC",
  SKIPPED: "Пропуснати (без телефон / затворени)",
  CONVERTED: "Записани след разговор",
};

export default async function PilotPage() {
  const ctx = await requirePageOwner("/pilot");
  const env = getEnv();
  if (ctx.mode !== "real") {
    return (
      <>
        <PageHeader title="Пилот: първи реални бизнеси" state={<StateBadge state="BLOCKED" />} />
        <Notice tone="info">
          Пилотът работи само в <strong>отделната реална база</strong> (без демо записи). Стартирай с <code>npm run real:init</code>, после <code>npm run real:dev</code>. Виж docs/PILOT.md.
        </Notice>
      </>
    );
  }
  const [rows, cov, usage] = await Promise.all([
    ctx.db.pilotCandidate.findMany({ orderBy: { createdAt: "asc" } }),
    historyCoverage(ctx.db),
    ctx.db.apiUsage.findUnique({ where: { month_sku: { month: localDateOf(ctx.clock.now()).slice(0, 7), sku: SKU_DETAILS_ENTERPRISE } } }),
  ]);
  const gate = placesGate(env);
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, rows.filter((r) => r.status === k).length]));
  return (
    <>
      <PageHeader
        title="Пилот: първи реални бизнеси"
        sub="До 25 кандидата, ръчен преглед преди обаждане. Данните от Google се зареждат на живо и не се записват — пази се само place_id."
        state={gate.ok ? <StateBadge state="IMPLEMENTED_NOT_LIVE_VERIFIED" /> : <StateBadge state="BLOCKED" title={gate.reason} />}
      />
      <div className="mb-4 space-y-2">
        {cov.imported === 0 ? (
          <Notice tone="warn">
            Старата контактна история <strong>не е импортирана</strong>. Сравнението е само с текущата реална база — не може да се гарантира, че никога не си звънял на тези бизнеси. Импорт: Нови клиенти → Импорт CSV.
          </Notice>
        ) : (
          <Notice tone="info">Сравнение със старата история: {cov.imported} импортирани записа ({cov.withHistory} с история). Съвпадение се търси по телефон, сайт и име + град.</Notice>
        )}
        {!gate.ok && <Notice tone="warn">Google Places: {gate.reason}</Notice>}
        <p className="text-xs text-muted">
          Place Details (Enterprise) този месец: {usage?.count ?? 0} от {env.PLACES_MAX_DETAILS_PER_MONTH} (лимит в приложението; Google дава 1000 безплатни/месец). Всяко „Зареди данните“ е една заявка.
        </p>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.entries(STATUS_LABELS).map(([k, l]) => (
          <Badge key={k}>
            {l}: {counts[k]}
          </Badge>
        ))}
      </div>
      {rows.length === 0 ? (
        <Notice tone="info">
          Няма кандидати. План (без заявки): <code>npm run pilot:discover</code>. Реално откриване: <code>npm run pilot:discover -- --run --limit=25</code>.
        </Notice>
      ) : (
        <PilotList
          canLoad={gate.ok}
          items={rows
            .filter((r) => ["PENDING_REVIEW", "APPROVED", "REJECTED", "CONVERTED", "IN_HISTORY"].includes(r.status))
            .map((r) => ({ id: r.id, status: r.status, statusLabel: STATUS_LABELS[r.status] ?? r.status, city: r.city, category: CATEGORY_LABELS[r.category] ?? r.category, businessId: r.businessId, note: r.reviewNote }))}
        />
      )}
    </>
  );
}
