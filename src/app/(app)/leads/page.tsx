import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { AddLeadButton, SavedFilters } from "@/components/client/LeadsTools";
import { LeadDetail } from "@/components/LeadDetail";
import { LeadList, type LeadListRow } from "@/components/LeadList";
import { Empty, PageHeader, StateBadge, Tabs } from "@/components/ui";
import { CATEGORIES, HISTORY_LABELS, OUTCOME_LABELS, OUTCOMES, STAGE_LABELS, STAGES, WEBSITE_STATUS_LABELS } from "@/domain/constants";
import { normalizeName } from "@/domain/identity";
import { loadLeadDetail } from "@/domain/leadDetail";
import { requirePageOwner } from "@/lib/server";
import { isLocalDate, zonedToUtc, addDays } from "@/lib/time";

export const metadata = { title: "Нови клиенти / база" };
const PAGE = 50;

type SP = Record<string, string | undefined>;

function buildWhere(sp: SP): Prisma.BusinessWhereInput {
  const and: Prisma.BusinessWhereInput[] = [{ mergedIntoId: null }];
  const tab = sp.tab ?? "new";
  if (tab === "new") and.push({ pipelineStage: "NEW", status: "ACTIVE", suppressions: { none: { liftedAt: null } } });
  if (tab === "review") and.push({ status: "ACTIVE", OR: [{ reviewStatus: { not: "NONE" } }, { contactHistoryState: "UNKNOWN" }] });
  if (tab === "archived") and.push({ OR: [{ status: { not: "ACTIVE" } }, { suppressions: { some: { liftedAt: null } } }] });
  if (sp.q?.trim()) {
    const q = sp.q.trim().slice(0, 80);
    const nq = normalizeName(q);
    const digits = q.replace(/\D/g, "");
    and.push({
      OR: [
        ...(nq ? [{ normalizedName: { contains: nq } }] : []),
        { ref: { contains: q.toUpperCase() } },
        { city: { contains: q } },
        ...(digits.length >= 3 ? [{ phoneNormalized: { contains: digits } }] : []),
      ],
    });
  }
  if (sp.city) and.push({ city: sp.city });
  if (sp.category) and.push({ category: sp.category });
  if (sp.scoreMin && /^\d+$/.test(sp.scoreMin)) and.push({ score: { gte: Number(sp.scoreMin) } });
  if (sp.website) and.push({ websiteStatus: sp.website });
  if (sp.outcome) and.push(sp.outcome === "none" ? { lastOutcome: null } : { lastOutcome: sp.outcome });
  if (sp.stage) and.push({ pipelineStage: sp.stage });
  if (sp.history) and.push({ contactHistoryState: sp.history });
  if (sp.source) and.push({ source: sp.source });
  if (sp.issuedFrom && isLocalDate(sp.issuedFrom)) and.push({ firstIssuedAt: { gte: zonedToUtc(sp.issuedFrom, "00:00") } });
  if (sp.issuedTo && isLocalDate(sp.issuedTo)) and.push({ firstIssuedAt: { lt: zonedToUtc(addDays(sp.issuedTo, 1), "00:00") } });
  if (sp.issued === "yes") and.push({ firstIssuedAt: { not: null } });
  if (sp.issued === "no") and.push({ firstIssuedAt: null });
  if (sp.followup === "open") and.push({ followUps: { some: { status: "OPEN" } } });
  if (sp.followup === "none") and.push({ followUps: { none: { status: "OPEN" } } });
  if (sp.dupe === "yes") and.push({ reviewStatus: "DUPLICATE_REVIEW" });
  return { AND: and };
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/leads");
  const now = ctx.clock.now();
  const tab = sp.tab ?? "new";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const where = buildWhere(sp);
  const [total, rows, cities, counts] = await Promise.all([
    ctx.db.business.count({ where }),
    ctx.db.business.findMany({
      where,
      orderBy: sp.sort === "ref" ? [{ ref: "asc" }] : [{ score: { sort: "desc", nulls: "last" } }, { ref: "asc" }],
      skip: (page - 1) * PAGE,
      take: PAGE,
      include: { activities: { orderBy: { occurredAt: "desc" }, take: 1 }, suppressions: { where: { liftedAt: null } }, batchItem: { include: { batch: { select: { localDate: true } } } } },
    }),
    ctx.db.business.findMany({ where: { mergedIntoId: null }, distinct: ["city"], select: { city: true }, orderBy: { city: "asc" } }),
    Promise.all(["new", "all", "review", "archived"].map((t) => ctx.db.business.count({ where: buildWhere({ tab: t }) }))),
  ]);
  const detail = sp.id ? await loadLeadDetail(ctx.db, sp.id, ctx.mode, now) : null;
  const qs = (patch: SP) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
    return `/leads?${p.toString()}`;
  };
  const list: LeadListRow[] = rows.map((b) => ({
    ...b,
    issuedOn: b.batchItem?.batch.localDate ?? null,
    lastActivity: b.activities[0] ?? null,
    flags: [
      ...(b.suppressions.some((s) => s.type === "DNC") ? ["DNC"] : []),
      ...(b.suppressions.some((s) => s.type === "INVALID_PHONE") ? ["Невалиден номер"] : []),
      ...(b.reviewStatus === "DUPLICATE_REVIEW" ? ["Възможен дубликат"] : []),
      ...(b.contactHistoryState === "UNKNOWN" ? ["Неизвестна история"] : []),
      ...(b.status === "ARCHIVED" ? ["Архивиран"] : []),
    ],
  }));
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const sel = (name: string, label: string, opts: [string, string][]) => (
    <div>
      <label className="label" htmlFor={`f-${name}`}>
        {label}
      </label>
      <select id={`f-${name}`} name={name} defaultValue={sp[name] ?? ""} className="field min-h-9 py-1 text-sm">
        <option value="">Всички</option>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className={detail ? "xl:grid xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-4" : ""}>
      <div className="min-w-0">
        <PageHeader
          title="Нови клиенти / база"
          sub={`${total} записа · данните са в базата (server-side търсене)`}
          state={ctx.mode === "demo" ? <StateBadge state="DEMO_SIMULATED" title="Демо базата съдържа синтетични бизнеси; реалните са с източник „Excel импорт“" /> : <StateBadge state="WORKING_LOCAL" />}
          actions={
            <>
              <AddLeadButton />
              <Link href="/leads/import" className="btn">
                Импорт CSV
              </Link>
              <a href="/api/export/leads" className="btn" data-noguard>
                Експорт CSV
              </a>
            </>
          }
        />
        <Tabs
          current={tab}
          items={[
            { key: "new", label: "Нови", count: counts[0] },
            { key: "all", label: "Всички", count: counts[1] },
            { key: "review", label: "За проверка", count: counts[2] },
            { key: "archived", label: "Архивирани/блокирани", count: counts[3] },
          ].map((t) => ({ ...t, href: `/leads?tab=${t.key}` }))}
        />
        <details className="card mb-3 p-3" open={Object.keys(sp).some((k) => !["tab", "page", "id", "q"].includes(k))}>
          <summary className="cursor-pointer text-sm font-medium">Филтри</summary>
          <form method="get" action="/leads" className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
            <input type="hidden" name="tab" value={tab} />
            <div className="col-span-2">
              <label className="label" htmlFor="f-q">
                Търсене
              </label>
              <input id="f-q" name="q" defaultValue={sp.q ?? ""} className="field min-h-9 py-1 text-sm" />
            </div>
            {sel("city", "Град", cities.map((c) => [c.city, c.city]))}
            {sel("category", "Категория", CATEGORIES.map((c) => [c.key, c.label]))}
            <div>
              <label className="label" htmlFor="f-scoreMin">
                Score ≥
              </label>
              <input id="f-scoreMin" name="scoreMin" inputMode="numeric" defaultValue={sp.scoreMin ?? ""} className="field min-h-9 py-1 text-sm" />
            </div>
            {sel("website", "Сайт", Object.entries(WEBSITE_STATUS_LABELS))}
            {sel("outcome", "Последен резултат", [["none", "Няма"], ...OUTCOMES.map((o) => [o, OUTCOME_LABELS[o]] as [string, string])])}
            {sel("stage", "Pipeline", STAGES.map((s) => [s, STAGE_LABELS[s]]))}
            {sel("history", "История на контакт", Object.entries(HISTORY_LABELS))}
            {sel("source", "Източник", [["XLSX", "Excel импорт (реални)"], ["DEMO", "Demo"], ["CSV", "CSV импорт"], ["MANUAL", "Ръчно"]])}
            {sel("issued", "Издаван", [["yes", "Да"], ["no", "Не"]])}
            <div>
              <label className="label" htmlFor="f-issuedFrom">
                Издаден от
              </label>
              <input id="f-issuedFrom" type="date" name="issuedFrom" defaultValue={sp.issuedFrom ?? ""} className="field min-h-9 py-1 text-sm" />
            </div>
            <div>
              <label className="label" htmlFor="f-issuedTo">
                Издаден до
              </label>
              <input id="f-issuedTo" type="date" name="issuedTo" defaultValue={sp.issuedTo ?? ""} className="field min-h-9 py-1 text-sm" />
            </div>
            {sel("followup", "Последващо", [["open", "Има отворено"], ["none", "Няма"]])}
            {sel("dupe", "Флаг дубликат", [["yes", "Да"]])}
            {sel("sort", "Подреди", [["ref", "По номер"]])}
            <div className="col-span-2 flex items-end gap-2">
              <button className="btn btn-primary btn-sm">Приложи</button>
              <Link href={`/leads?tab=${tab}`} className="btn btn-sm">
                Изчисти
              </Link>
            </div>
          </form>
          <SavedFilters />
        </details>

        {list.length === 0 ? <Empty title="Няма записи по тези филтри." /> : <LeadList rows={list} hrefFor={(id) => qs({ id })} selectedId={sp.id} showStage caption="Списък с контакти" />}
        <nav aria-label="Страници" className="mt-3 flex items-center justify-between text-sm">
          <span className="text-muted">
            Страница {page} от {pages}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Link className="btn btn-sm" href={qs({ page: String(page - 1), id: undefined })}>
                ← Предишна
              </Link>
            )}
            {page < pages && (
              <Link className="btn btn-sm" href={qs({ page: String(page + 1), id: undefined })}>
                Следваща →
              </Link>
            )}
          </span>
        </nav>
        <p className="mt-2 text-xs text-muted">Масово „Позвъних“ не съществува — всеки резултат се записва индивидуално.</p>
      </div>
      {detail && (
        <aside className="mt-4 xl:sticky xl:top-16 xl:mt-0 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto" aria-label="Детайли на контакт">
          <LeadDetail d={detail} mode={ctx.mode} now={now} closeHref={qs({ id: undefined })} />
        </aside>
      )}
    </div>
  );
}
