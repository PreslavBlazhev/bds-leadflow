import Link from "next/link";
import { AckOnView } from "@/components/client/AckOnView";
import { ActionButton } from "@/components/client/ActionButton";
import { DemoPanel, TomorrowPreview } from "@/components/client/DemoPanel";
import { PauseToggle } from "@/components/client/PauseToggle";
import { LeadDetail } from "@/components/LeadDetail";
import { LeadList, type LeadListRow } from "@/components/LeadList";
import { Badge, Empty, Notice, PageHeader, Section, Stat, StateBadge } from "@/components/ui";
import { backlogItems, batchForDate } from "@/domain/batch";
import { CONTACT_ACTIVITY_TYPES, FOLLOWUP_KIND_LABELS } from "@/domain/constants";
import { scoreFactsOf, type CandidateRow } from "@/domain/eligibility";
import { humanReasonText } from "@/domain/reasons";
import { scoreBusiness } from "@/domain/scoring";
import { healthSummary } from "@/domain/health";
import { loadLeadDetail } from "@/domain/leadDetail";
import { realStockSummary } from "@/domain/realStock";
import { CATEGORY_LABELS } from "@/domain/constants";
import { dataMode, getSettings } from "@/domain/settings";
import { activeList, newListGate, nextListDate, realOnlyFor } from "@/domain/activeList";
import { getEnv } from "@/lib/env";
import { requirePageOwner } from "@/lib/server";
import { addDays, fmtDate, fmtDateTime, fmtTime, isLocalDate, localDateOf, zonedToUtc } from "@/lib/time";

export const metadata = { title: "Днес" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ id?: string; date?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/today");
  const now = ctx.clock.now();
  const today = localDateOf(now);
  const viewDate = sp.date && isLocalDate(sp.date) ? sp.date : today;
  const isToday = viewDate === today;
  const startToday = zonedToUtc(today, "00:00");
  const endToday = zonedToUtc(addDays(today, 1), "00:00");
  const settings = await getSettings(ctx.db);
  // Реален източник (или real база): демо контактите остават в историята, но не и в работните опашки.
  const realSource = realOnlyFor(ctx.mode, settings);
  const notDemo = realSource ? { business: { isDemo: false } } : {};
  // Реален режим: „Днес“ показва активния (неприключен) списък, дори да е издаден на предишна дата.
  const active = isToday && realSource ? await activeList(ctx.db, { realOnly: true }) : null;
  const activeDate = active?.batches[0]?.localDate ?? null;
  const listDate = isToday && activeDate ? activeDate : viewDate;
  const todayBatchRow = isToday ? await ctx.db.dailyBatch.findUnique({ where: { localDate: today }, select: { id: true, target: true, _count: { select: { items: true } } } }) : null;
  const gate = isToday && realSource ? await newListGate(ctx.db, settings, today, now, { existing: !!todayBatchRow, realOnly: true }) : null;
  const nextList = isToday && realSource && !(active && active.remaining > 0) ? await nextListDate(ctx.db, settings, now, true) : null;
  const [batch, backlog, overdue, dueToday, upcoming, processed, health, pastBatches, stock] = await Promise.all([
    batchForDate(ctx.db, listDate),
    isToday && !realSource ? backlogItems(ctx.db, today, { realOnly: realSource }) : Promise.resolve([]),
    ctx.db.followUp.findMany({ where: { status: "OPEN", dueAt: { lt: startToday }, ...notDemo }, include: { business: { select: { id: true, name: true, city: true } } }, orderBy: { dueAt: "asc" } }),
    ctx.db.followUp.findMany({ where: { status: "OPEN", dueAt: { gte: startToday, lt: endToday }, ...notDemo }, include: { business: { select: { id: true, name: true, city: true } } }, orderBy: { dueAt: "asc" } }),
    ctx.db.followUp.count({ where: { status: "OPEN", dueAt: { gte: endToday }, ...notDemo } }),
    ctx.db.activity.findMany({ where: { type: { in: ["CALL", "CONTACT_OTHER"] }, occurredAt: { gte: startToday, lt: endToday } }, select: { businessId: true }, distinct: ["businessId"] }),
    healthSummary(ctx.db, getEnv(), ctx.mode, now),
    ctx.db.dailyBatch.findMany({ orderBy: { localDate: "desc" }, take: 30, select: { localDate: true, _count: { select: { items: true } }, target: true } }),
    isToday && realSource ? realStockSummary(ctx.db, ctx.mode, now) : Promise.resolve(null),
  ]);
  const demoView = dataMode(ctx.mode, settings) === "demo";
  const detail = sp.id ? await loadLeadDetail(ctx.db, sp.id, ctx.mode, now) : null;
  const items = batch?.items ?? [];
  const demoItemsInBatch = items.filter((i) => i.business.isDemo).length;
  const contacted = new Set(
    items.filter((i) => i.business.activities[0] && (CONTACT_ACTIVITY_TYPES as string[]).includes(i.business.activities[0].type)).map((i) => i.businessId),
  );
  // Кратка, разбираема причина (техническите подробности са в детайлите на контакта).
  const reasonOf = (b: unknown) => {
    const facts = scoreFactsOf(b as CandidateRow);
    return humanReasonText(scoreBusiness(facts, settings), facts);
  };
  const rows: LeadListRow[] = items.map((i) => ({
    ...i.business,
    position: i.position,
    reason: reasonOf(i.business),
    score: i.scoreAtIssue,
    lastActivity: i.business.activities[0] ?? null,
    flags: [
      ...(i.business.suppressions.some((s) => s.type === "DNC") ? ["DNC"] : []),
      ...(i.business.suppressions.some((s) => s.type === "INVALID_PHONE") ? ["Невалиден номер"] : []),
      ...(i.processedAt ? ["✔ обработен"] : []),
      // Издаден контакт не изчезва при изтекла свежест — само предупреждение.
      ...(!i.processedAt && i.business.verifiedAt && now.getTime() - i.business.verifiedAt.getTime() > settings.reserveFreshnessDays * 86_400_000 ? ["Нужна нова проверка на данните"] : []),
    ],
  }));
  const backlogRows: LeadListRow[] = backlog.map((i) => ({ ...i.business, reason: reasonOf(i.business), score: i.scoreAtIssue, issuedOn: i.batch.localDate, lastActivity: i.business.activities[0] ?? null }));
  const href = (id: string) => `/today?${new URLSearchParams({ ...(isToday ? {} : { date: viewDate }), id }).toString()}`;
  const target = batch?.target ?? settings.dailyTarget;
  // При реален източник демо контактите от днешния (демо) списък не са в опашката „Нови днес“.
  const remainingNew = active ? active.remaining : items.filter((i) => !contacted.has(i.businessId) && !(realSource && i.business.isDemo)).length;
  const showingActive = !!active && active.remaining > 0;
  const listTitle = showingActive ? (activeDate === today ? "Активен списък (днешен)" : `Активен списък от ${fmtDate(activeDate!)}`) : isToday ? "Нови за днес" : "Издадени нови";
  const todayFull = !!todayBatchRow && todayBatchRow._count.items >= todayBatchRow.target;

  return (
    <div className={detail ? "xl:grid xl:grid-cols-[minmax(0,1fr)_420px] xl:gap-4" : ""}>
      <div className="min-w-0">
        {isToday && batch && <AckOnView />}
        <PageHeader
          title={isToday ? "Днес" : `Списък за ${fmtDate(viewDate)}`}
          sub={
            <>
              {fmtDate(today === viewDate ? today : viewDate)} · нови списъци {settings.activeWeekdays.length === 5 && settings.activeWeekdays.every((d) => d <= 5) ? "пн–пт" : "в избраните дни"} в {settings.publishTime} (Europe/Sofia)
              {batch?.publishedAt && ` · публикуван ${fmtDateTime(batch.publishedAt)}${batch.late ? " (закъснял)" : ""}`}
            </>
          }
          state={demoView ? <StateBadge state="DEMO_SIMULATED" title="Синтетични демо бизнеси — не са реално намерени клиенти" /> : <StateBadge state="WORKING_LOCAL" />}
          actions={
            isToday && (
              realSource ? (
                <>
                  {showingActive ? (
                    <Link href="/calls?queue=new" className="btn btn-primary">
                      {active!.handled === 0 ? `Започни обажданията (${active!.remaining})` : `Продължи останалите ${active!.remaining}`}
                    </Link>
                  ) : (
                    <Link href="/calls?queue=followups" className="btn btn-primary">
                      Повторни обаждания ({overdue.length + dueToday.length})
                    </Link>
                  )}
                  {todayFull ? (
                    <span className="inline-flex min-h-10 items-center rounded-lg border border-emerald-800 px-3 text-sm text-ok" role="status">
                      ✔ За днес вече има издаден списък — втори не се издава
                    </span>
                  ) : (
                    // Правилата се проверяват и на сървъра; тук — разбираема причина, ако действието не е достъпно.
                    <ActionButton url="/api/batch/publish" disabledReason={gate && !gate.ok ? gate.reason ?? "не е достъпно" : null} resultKind="publish">
                      {todayBatchRow ? "Допълни днешния списък" : "Създай днешния списък"}
                    </ActionButton>
                  )}
                </>
              ) : (
              <>
                <Link href="/calls?queue=new" className="btn btn-primary">
                  Започни обажданията{remainingNew ? ` (${remainingNew})` : ""}
                </Link>
                {batch && items.length >= target ? (
                  <span className="inline-flex min-h-10 items-center rounded-lg border border-emerald-800 px-3 text-sm text-ok" role="status">
                    ✔ Списъкът е готов ({items.length}/{target})
                  </span>
                ) : (
                  // Защитата остава: повторно натискане не създава втори списък и не подменя издадените контакти.
                  <ActionButton url="/api/batch/publish" disabledReason={!batch && health.paused ? "новите списъци са на пауза" : null} resultKind="publish">
                    {batch ? "Допълни списъка" : "Създай днешния списък"}
                  </ActionButton>
                )}
              </>
              )
            )
          }
        />

        {realSource && isToday ? (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Активен списък" value={showingActive ? `${active!.handled} / ${active!.total}` : "—"} hint={showingActive ? "обработени" : "няма активен"} />
            <Stat label="Остават в активния" value={active?.remaining ?? 0} tone={active && active.remaining ? "warn" : undefined} />
            <Stat label="Повторни — просрочени" value={overdue.length} tone={overdue.length ? "bad" : undefined} />
            <Stat label="Повторни — днес" value={dueToday.length} hint={`предстоящи: ${upcoming}`} />
            <Stat label="Запас (допустими нови)" value={stock?.eligible ?? 0} tone={stock && stock.eligible < stock.target ? "warn" : undefined} />
          </div>
        ) : (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Нови" value={`${items.length} / ${target}`} tone={items.length < target ? "warn" : undefined} hint={demoItemsInBatch > 0 ? (demoItemsInBatch === items.length ? "демо (синтетични)" : `${demoItemsInBatch} демо`) : items.length ? "реални" : undefined} />
          <Stat label="Обработени днес" value={processed.length} hint="записан резултат" />
          <Stat label="Нови без резултат" value={remainingNew} />
          <Stat label="Просрочени последващи" value={overdue.length} tone={overdue.length ? "bad" : undefined} />
          <Stat label="Последващи днес" value={dueToday.length} hint={`предстоящи: ${upcoming}`} />
          <Stat label="Необработени от предишни дни" value={backlog.length} tone={backlog.length > settings.backlogWarningThreshold ? "warn" : undefined} />
        </div>
        )}

        <div className="mb-4 space-y-2">
          {showingActive && (
            <Notice tone="info">
              <div className="space-y-0.5">
                <div>
                  <strong>{activeDate === today ? "Активен списък (днешен)" : `Активен списък от ${fmtDate(activeDate!)}`}</strong>
                </div>
                <div>
                  Обработени: <strong>{active!.handled} от {active!.total}</strong> · Остават <strong>{active!.remaining}</strong> {active!.remaining === 1 ? "контакт" : "контакта"}
                </div>
                <div className="text-muted">Следващият списък ще бъде издаден след приключването им, в следващия работен ден в {settings.publishTime}.</div>
              </div>
            </Notice>
          )}
          {realSource && isToday && !showingActive && (
            <Notice tone={gate && !gate.ok && gate.code !== "BEFORE_TIME" ? "warn" : "info"}>
              Няма активен списък.{" "}
              {nextList ? (
                <>
                  Следващ нов списък: <strong>{fmtDate(nextList.localDate)} в {settings.publishTime}</strong>.
                </>
              ) : (
                "Следващ нов списък: няма определена дата (пауза или няма запас)."
              )}{" "}
              {gate && !gate.ok && gate.code !== "BEFORE_TIME" ? gate.reason : ""}
            </Notice>
          )}
          {realSource && demoItemsInBatch > 0 && (
            <Notice tone="info">
              Този списък е <strong>демо</strong> — публикуван преди превключването към реални данни. Запазен е като история; демо контактите не влизат в опашките за обаждания.
              {isToday && stock?.firstDate && (
                <>
                  {" "}
                  Следващ реален списък: <strong>{fmtDate(stock.firstDate)} в {stock.publishTime}</strong>.
                </>
              )}
            </Notice>
          )}
          {isToday && !batch && !realSource && (
            <Notice tone="warn">
              Няма публикуван списък за днес. {health.paused ? "Новите списъци са на пауза." : `Резерв: ${health.reserve.reserve} допустими. ${health.workerAlive ? "Worker-ът работи." : `${health.worker.text} Няма автоматично публикуване в ${settings.publishTime}.`}`}
            </Notice>
          )}
          {batch && items.length === 0 && <Notice tone="bad">Няма подготвени нови контакти. {batch.shortfallReason}</Notice>}
          {batch && items.length > 0 && items.length < target && <Notice tone="warn">Частичен списък: {batch.shortfallReason}</Notice>}
          {isToday && overdue.length > 0 && (
            <Notice tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {overdue.length} {overdue.length === 1 ? "просрочено последващо действие" : "просрочени последващи действия"}.
                </span>
                <span className="flex flex-wrap gap-2">
                  <Link href="/follow-ups?tab=overdue" className="btn btn-sm">
                    Прегледай просрочените
                  </Link>
                  <Link href="/calls?queue=followups" className="btn btn-sm">
                    Обади се по ред
                  </Link>
                </span>
              </div>
            </Notice>
          )}
          {isToday && backlog.length > settings.backlogWarningThreshold && (
            <Notice tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {backlog.length} необработени контакта от предишни дни — издадени, но без записан резултат. Те не се смятат за нови.
                  {!settings.pauseNewLists && " Ако не смогваш, спри временно новите списъци; целта не се променя автоматично."}
                </span>
                <span className="flex flex-wrap items-start gap-2">
                  <Link href="/calls?queue=backlog" className="btn btn-sm">
                    Продължи необработените
                  </Link>
                  {!settings.pauseNewLists && <PauseToggle paused={false} />}
                </span>
              </div>
            </Notice>
          )}
          {isToday && settings.pauseNewLists && (
            <Notice tone="info">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>Новите списъци са на пауза.</strong> Нов списък няма да се създава (вкл. автоматично в {settings.publishTime}); последващите действия и необработените контакти продължават.
                </span>
                <PauseToggle paused />
              </div>
            </Notice>
          )}
          {isToday && health.reserve.reserve < health.reserve.reserveTarget && (
            <Notice tone="info">
              Резервът е {health.reserve.reserve} при цел {health.reserve.reserveTarget} проверени допустими бизнеса.
            </Notice>
          )}
        </div>

        {stock && <RealStockPanel s={stock} workerAlive={health.workerAlive} workerText={health.worker.text} paused={settings.pauseNewLists || settings.paused} />}
        {batch && (
          <details className="card mb-4 p-3 text-sm">
            <summary className="cursor-pointer font-medium">Защо тези контакти?</summary>
            <div className="mt-2 space-y-2 text-muted">
              <p>
                Избрани са само бизнеси, на които никога не сме се обаждали и не са били в предишен списък: без DNC, без история, с проверен телефон, в разрешените градове и категории. Подредени са по
                търговски приоритет (score) — сигналите са в колоната „Причина“, подробностите са в картата на контакта.
              </p>
              {(() => {
                const plan = JSON.parse(batch.quotaPlan || "{}") as Record<string, { quota: number; available: number; taken: number }>;
                const entries = Object.entries(plan);
                return entries.length ? (
                  <ul className="list-disc pl-5">
                    {entries.map(([city, p]) => (
                      <li key={city}>
                        {city}: квота {p.quota}, налични допустими {p.available}, избрани {p.taken}
                      </li>
                    ))}
                  </ul>
                ) : null;
              })()}
              {batch.shortfallReason && <p>{batch.shortfallReason}</p>}
            </div>
          </details>
        )}

        <Section title={listTitle} count={items.length} id="new">
          {items.length ? <LeadList rows={rows} hrefFor={href} selectedId={sp.id} showPosition caption="Нови контакти" /> : <Empty title="Няма нови контакти в този списък." />}
        </Section>

        {isToday && (
          <>
            <Section
              title={realSource ? "Повторни обаждания и последващи — просрочени и за днес" : "Последващи действия — просрочени и за днес"}
              count={overdue.length + dueToday.length}
              id="fu"
              actions={
                overdue.length + dueToday.length > 0 && (
                  <Link href="/calls?queue=followups" className="btn btn-sm">
                    Обади се по ред
                  </Link>
                )
              }
            >
              {overdue.length + dueToday.length === 0 ? (
                <Empty title="Няма последващи действия за днес." />
              ) : (
                <ul className="card divide-y divide-line">
                  {[...overdue, ...dueToday].map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>
                        {f.dueAt < startToday ? <Badge tone="bad">■ Просрочено</Badge> : <Badge tone="info">Днес {fmtTime(f.dueAt)}</Badge>}{" "}
                        <Link href={href(f.business.id)}>{f.business.name}</Link> <span className="text-muted">· {f.business.city} · {FOLLOWUP_KIND_LABELS[f.kind]} · {f.reason}</span>
                      </span>
                      <Link href={`/calls?id=${f.business.id}`} className="btn btn-sm">
                        Обади се
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-muted">Последващите действия никога не се броят в дневните нови.</p>
            </Section>

            {!realSource && (
            <Section
              title="Необработени от предишни дни"
              count={backlog.length}
              id="unprocessed"
              actions={
                backlog.length > 0 && (
                  <Link href="/calls?queue=backlog" className="btn btn-sm">
                    Продължи необработените
                  </Link>
                )
              }
            >
              {backlog.length ? <LeadList rows={backlogRows} hrefFor={href} selectedId={sp.id} caption="Необработени от предишни дни" /> : <Empty title="Няма необработени контакти от предишни дни." />}
              <p className="mt-1 text-xs text-muted">Показани вчера или по-рано, но още без записан резултат. Те НЕ са нови и не заемат място в днешните {target}.</p>
            </Section>
            )}
          </>
        )}

        <Section title="История по дати" id="hist">
          <div className="flex flex-wrap gap-1.5">
            {pastBatches.length === 0 && <span className="text-sm text-muted">Още няма публикувани списъци.</span>}
            {pastBatches.map((pb) => (
              <Link key={pb.localDate} href={pb.localDate === today ? "/today" : `/today?date=${pb.localDate}`} aria-current={pb.localDate === viewDate ? "page" : undefined} className={`btn btn-sm ${pb.localDate === viewDate ? "border-accent" : ""}`}>
                {fmtDate(pb.localDate)} <span className="tabular text-xs text-muted">{pb._count.items}/{pb.target}</span>
              </Link>
            ))}
          </div>
        </Section>

        {isToday && demoView && <DemoPanel />}
        {isToday && !realSource && <TomorrowPreview />}
      </div>
      {detail && (
        <aside className="mt-4 xl:sticky xl:top-16 xl:mt-0 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto" aria-label="Детайли на контакт">
          <LeadDetail d={detail} mode={ctx.mode} now={now} closeHref={isToday ? "/today" : `/today?date=${viewDate}`} />
        </aside>
      )}
    </div>
  );
}

type Stock = Awaited<ReturnType<typeof realStockSummary>>;

/** Реален дневен режим: кога започва, какъв е запасът и кои ще са първите (само преглед, без резервиране). */
function RealStockPanel({ s, workerAlive, workerText, paused }: { s: Stock; workerAlive: boolean; workerText: string; paused: boolean }) {
  const low = s.eligible < s.target;
  const stale = s.staleUnused > 0 && s.firstExpiry;
  const last = s.plannedDays[s.plannedDays.length - 1];
  return (
    <Section title="Запас и следващ нов списък" id="real">
      <div className="space-y-2">
        <Notice tone={paused ? "warn" : "info"}>
          {paused ? (
            <>Новите списъци са на пауза — реален списък няма да се публикува, докато не ги възобновиш.</>
          ) : s.activeRemaining > 0 ? (
            <>
              Нов списък няма да бъде издаден, докато в активния има необработени контакти (остават {s.activeRemaining}). След приключването им — в следващия работен ден в {s.publishTime}.
            </>
          ) : s.firstDate ? (
            <>
              Следващ нов списък: <strong>{fmtDate(s.firstDate)} в {s.publishTime}</strong> (Europe/Sofia) — до {s.target} нови.{" "}
              {workerAlive ? "Worker-ът работи." : `${workerText} Без работещ worker списъкът се създава при следващото му стартиране в същия ден или с бутона „Създай днешния списък“.`}
            </>
          ) : (
            <>Няма активен ден за публикуване в следващите две седмици (Настройки → дни).</>
          )}
        </Notice>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Допустими непрозвънени" value={s.eligible} tone={low ? "warn" : undefined} hint={Object.entries(s.byPriority).map(([k, v]) => `${k}: ${v}`).join(" · ")} />
          <Stat label={`Пълни дни по ${s.target}`} value={s.fullDays} hint={`остатък ${s.eligible % s.target}`} />
          <Stat label="Списъци преди остаряване" value={s.plannedDays.length} hint={last ? `последен ${fmtDate(last.localDate)}` : undefined} tone={stale ? "warn" : undefined} />
          <Stat label="Свежест на проверката" value={`${s.freshnessDays} дни`} hint={s.firstExpiry ? `изтича ${fmtDateTime(s.firstExpiry)}` : undefined} />
        </div>
        {low && (
          <Notice tone="warn">
            Запасът е под дневната цел: само <strong>{s.eligible}</strong> допустими. Списъкът ще е частичен — без повторения и без демо записи.
          </Notice>
        )}
        {stale && (
          <Notice tone="warn">
            Датата на проверката във файла е по-стара: при „свежест {s.freshnessDays} дни“ около <strong>{s.staleUnused}</strong> кандидата остаряват на {fmtDateTime(s.firstExpiry!)}, преди да влязат в списък. Ако данните още са актуални, можеш да увеличиш „Свежест на резерва“ в Настройки — приложението не я променя само.
          </Notice>
        )}
        {s.preview && s.preview.items.length > 0 && (
          <details className="card p-3 text-sm" open>
            <summary className="cursor-pointer font-medium">
              Преглед: следващите {s.preview.items.length} реални кандидата{s.firstDate ? ` за ${fmtDate(s.firstDate)}` : " (датата зависи от приключването на активния списък)"} — нищо не е резервирано
            </summary>
            <ol className="mt-2 list-decimal space-y-0.5 pl-6">
              {s.preview.items.map((i) => (
                <li key={i.id}>
                  <Link href={`/today?id=${i.id}`}>{i.name}</Link> <span className="text-muted">· {i.ref} · {i.reason}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted">
              Подредба: първо приоритет A, после B, с редуване по категории ({Object.entries(s.byCategory).map(([k, v]) => `${CATEGORY_LABELS[k] ?? k} ${v}`).join(", ")}). Окончателният списък се избира в момента на публикуване по същите правила.
            </p>
          </details>
        )}
      </div>
    </Section>
  );
}
