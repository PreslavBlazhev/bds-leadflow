import Link from "next/link";
import { ActionButton } from "@/components/client/ActionButton";
import { PushManager, RevokeDevice, TestNotificationButtons } from "@/components/client/PushManager";
import { SettingsForm } from "@/components/client/SettingsForm";
import { Badge, Notice, PageHeader, Stat, StateBadge, Tabs } from "@/components/ui";
import { healthSummary } from "@/domain/health";
import { getSettings } from "@/domain/settings";
import { getEnv, providerStatus } from "@/lib/env";
import { providerOf } from "@/lib/db";
import { requirePageOwner } from "@/lib/server";
import { fmtDate, fmtDateTime } from "@/lib/time";
import { emailConfigured, pushConfigured } from "@/providers/delivery";

export const metadata = { title: "Настройки" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageOwner("/settings");
  const env = getEnv();
  const tab = sp.tab ?? "plan";
  const now = ctx.clock.now();
  const [settings, health, subs, outbox, dncCount, cities] = await Promise.all([
    getSettings(ctx.db),
    healthSummary(ctx.db, env, ctx.mode, now),
    ctx.db.pushSubscription.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, label: true, createdAt: true, lastSuccessAt: true, lastFailureAt: true, failureCount: true, revokedAt: true, expiredAt: true } }),
    ctx.db.notificationOutbox.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { _count: { select: { deliveries: true } } } }),
    ctx.db.suppression.count({ where: { type: "DNC", liftedAt: null, identifierType: null } }),
    ctx.db.business.findMany({ distinct: ["city"], select: { city: true }, orderBy: { city: "asc" } }),
  ]);
  const providers = providerStatus(env);
  const items = [
    { key: "plan", label: "План и квоти" },
    { key: "notify", label: "Известия и устройства" },
    { key: "providers", label: "Източници" },
    { key: "health", label: "Health" },
    { key: "jobs", label: "Jobs и известия" },
    { key: "data", label: "Данни, backup, retention" },
  ].map((t) => ({ ...t, href: `/settings?tab=${t.key}` }));

  return (
    <>
      <PageHeader title="Настройки" sub={`Режим: ${ctx.mode === "demo" ? "DEMO (отделна demo база)" : "REAL"} · Europe/Sofia`} />
      <Tabs items={items} current={tab} />

      {tab === "plan" && (
        <SettingsForm initial={settings} knownCities={cities.map((c) => c.city)} />
      )}

      {tab === "notify" && (
        <div className="space-y-4">
          <Notice tone={health.notifications.state === "INACTIVE" ? "bad" : "info"}>{health.notifications.text}</Notice>
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Push на това устройство</h2>
            <p className="mb-2 text-sm text-muted">
              Изисква secure context (HTTPS или localhost). Телефон през HTTP LAN адрес НЕ поддържа push. Push към истински телефон: <Badge tone="warn">NOT VERIFIED</Badge>
            </p>
            <PushManager vapidPublicKey={env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} demo={ctx.mode === "demo"} />
          </section>
          <section className="card p-3">
            <h2 className="mb-2 text-base font-semibold">Регистрирани устройства ({subs.filter((s) => !s.revokedAt && !s.expiredAt).length} активни)</h2>
            {subs.length === 0 ? (
              <p className="text-sm text-muted">Няма регистрирани устройства. Без устройство се използва резервният имейл (ако е конфигуриран).</p>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Устройство</th>
                    <th>Добавено</th>
                    <th>Последно прието</th>
                    <th>Статус</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => (
                    <tr key={s.id}>
                      <td>{s.label ?? "Браузър"}</td>
                      <td>{fmtDateTime(s.createdAt)}</td>
                      <td>{fmtDateTime(s.lastSuccessAt)}</td>
                      <td>{s.revokedAt ? "Премахнато" : s.expiredAt ? "Изтекло (404/410)" : s.failureCount ? `Грешки: ${s.failureCount}` : "Активно"}</td>
                      <td>{!s.revokedAt && <RevokeDevice id={s.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Тест</h2>
            <p className="mb-2 text-sm text-muted">
              In-app preview ≠ реален test push/имейл. В demo тестът е само локален preview. В real изисква ALLOW_REAL_TEST_DELIVERY=true и конфигурация; изпраща неутрален текст без данни за клиенти.
            </p>
            <TestNotificationButtons
              pushReason={ctx.mode === "real" && !env.ALLOW_REAL_TEST_DELIVERY ? "ALLOW_REAL_TEST_DELIVERY=false" : ctx.mode === "real" && !pushConfigured(env) ? "липсват VAPID ключове" : null}
              emailReason={ctx.mode === "real" && !env.ALLOW_REAL_TEST_DELIVERY ? "ALLOW_REAL_TEST_DELIVERY=false" : ctx.mode === "real" && !emailConfigured(env) ? "липсва SMTP конфигурация/OWNER_NOTIFY_EMAIL" : null}
              demo={ctx.mode === "demo"}
            />
          </section>
          <section className="card p-3 text-sm">
            <h2 className="mb-1 text-base font-semibold">Правило за резервния имейл</h2>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>След публикуване: push към активните owner устройства (един outbox запис, fan-out към устройствата).</li>
              <li>Няма устройство / отказан permission / окончателен отказ на всички endpoints → един резервен имейл веднага (ако е конфигуриран).</li>
              <li>Иначе: ако до {settings.notifications.fallbackDelayMinutes} мин. след по-късното от планирания час и публикуването списъкът не е отворен → един резервен имейл. Това е fallback по липса на отваряне, не доказателство, че push не е доставен.</li>
              <li>Отварянето на „Днес“ го отменя; проверява се отново непосредствено преди изпращане.</li>
              <li>provider_accepted ≠ доставено ≠ прочетено. SMTP няма idempotency key — при timeout след приемане е възможен дубликат (документиран риск).</li>
            </ul>
          </section>
        </div>
      )}

      {tab === "providers" && (
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.key} className="card flex flex-wrap items-start justify-between gap-2 p-3">
              <div>
                <div className="font-medium">{p.label}</div>
                <div className="text-sm text-muted">{p.reason}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{p.configured ? "configured" : "missing"}</Badge>
                <StateBadge state={p.state} />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted">API ключовете никога не се връщат към браузъра — показва се само configured/missing. Виж docs/DATA-SOURCES.md.</p>
        </div>
      )}

      {tab === "health" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Worker" value={health.workerAlive ? "Работи" : health.worker.status === "problem" ? "Проблем" : "Не работи"} tone={health.workerAlive ? "ok" : health.worker.status === "problem" ? "warn" : "bad"} hint={health.heartbeatAt ? `пулс ${fmtDateTime(health.heartbeatAt)}` : "няма пулс"} />
            <Stat label="Днешен списък" value={health.batch ? `${health.batch.total}/${health.batch.target}` : "няма"} tone={health.batch ? (health.batch.total < health.batch.target ? "warn" : "ok") : "warn"} hint={health.batch?.publishedAt ? `${fmtDateTime(health.batch.publishedAt)}${health.batch.late ? " (закъснял)" : ""}` : undefined} />
            <Stat label="Резерв (допустими)" value={`${health.reserve.reserve}`} hint={`цел ${health.reserve.reserveTarget}`} tone={health.reserve.reserve < settings.dailyTarget ? "bad" : health.reserve.reserve < health.reserve.reserveTarget ? "warn" : "ok"} />
            <Stat label="Следващо планирано" value={health.next ? fmtDate(health.next.localDate) : "—"} hint={health.next ? `${fmtDateTime(health.next.at)}${health.paused ? " · пауза" : ""}` : health.paused ? "на пауза" : undefined} />
            <Stat label="Известия чакащи" value={health.pendingN} />
            <Stat label="Известия с грешка" value={health.failedN} tone={health.failedN ? "warn" : undefined} />
            <Stat label="Push устройства" value={health.subs} />
            <Stat label="Активни DNC" value={dncCount} />
          </div>
          <div className="card space-y-1 p-3 text-sm" aria-label="Състояние на worker-а">
            <p className="font-medium">{health.worker.text}</p>
            <p className="text-muted">
              Последно успешно изпълнение: {health.worker.lastSuccessAt ? fmtDateTime(health.worker.lastSuccessAt) : "—"} · Следваща проверка: {health.worker.nextCheckAt ? fmtDateTime(health.worker.nextCheckAt) : "—"} · Праг за остарял пулс: {health.worker.staleAfterSeconds} с
            </p>
            <p className="text-muted">
              График (SCHEDULER_ENABLED): {health.worker.schedulerEnabled ? "включен" : "изключен"} · Външни доставки (DELIVERIES_ENABLED): {health.worker.deliveriesEnabled ? "включени" : "изключени"}
            </p>
            {health.worker.lastError && (
              <p className="text-warn">
                Последна грешка{health.worker.lastErrorAt ? ` (${fmtDateTime(health.worker.lastErrorAt)})` : ""}: {health.worker.lastError}
              </p>
            )}
          </div>
          {(health.worker.status === "stale" || health.worker.status === "none") && (
            <Notice tone="bad">
              Worker-ът не работи. Без него няма автоматична подготовка в {settings.prepareTime}, публикуване в {settings.publishTime} и изпращане на известия. Изключен компютър = няма изпълнение. Стартирай: <code>npm run worker:dev</code> или <code>npm run dev:all</code>.
            </Notice>
          )}
          <Notice tone="info">
            Резерв по градове: {Object.entries(health.reserve.byCity).map(([c, n]) => `${c} ${n}`).join(" · ") || "няма"}. Live откриване: BLOCKED (няма разрешен източник). Budget/quota: няма платени API заявки (0).
          </Notice>
        </div>
      )}

      {tab === "jobs" && (
        <div className="space-y-4">
          <section>
            <h2 className="mb-2 text-base font-semibold">Последни jobs</h2>
            <div className="overflow-x-auto">
              <table className="data card">
                <thead>
                  <tr>
                    <th>Ключ</th>
                    <th>Статус</th>
                    <th>Опити</th>
                    <th>Старт / край</th>
                    <th>Грешка</th>
                  </tr>
                </thead>
                <tbody>
                  {health.jobs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-muted">
                        Няма изпълнени jobs (worker-ът не е стартиран или още не е дошъл часът).
                      </td>
                    </tr>
                  )}
                  {health.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <code className="text-xs">{j.key}</code>
                        {j.late && <Badge tone="warn">закъснял</Badge>}
                      </td>
                      <td>{j.status}</td>
                      <td className="tabular">{j.attempts}</td>
                      <td className="text-xs">
                        {fmtDateTime(j.startedAt)} / {fmtDateTime(j.finishedAt)}
                      </td>
                      <td className="text-xs text-bad">{j.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-base font-semibold">Outbox (известия)</h2>
            <div className="overflow-x-auto">
              <table className="data card">
                <thead>
                  <tr>
                    <th>Ключ</th>
                    <th>Канал</th>
                    <th>Статус</th>
                    <th>Не по-рано от</th>
                    <th>Опити/доставки</th>
                    <th>Грешка</th>
                  </tr>
                </thead>
                <tbody>
                  {outbox.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <code className="text-xs">{o.dedupeKey}</code>
                      </td>
                      <td>{o.channel}</td>
                      <td>{o.status === "simulated" ? <Badge tone="demo">simulated (preview)</Badge> : o.status === "provider_accepted" ? <Badge tone="info">provider_accepted ≠ доставено</Badge> : o.status}</td>
                      <td className="text-xs">{fmtDateTime(o.notBefore)}</td>
                      <td className="tabular">
                        {o.attempts}/{o._count.deliveries}
                      </td>
                      <td className="text-xs text-bad">{o.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === "data" && (
        <div className="space-y-3 text-sm">
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Сесии</h2>
            <p className="mb-2 text-muted">Изход от всички устройства (включително това). Паролата не се променя; влизаш отново със същата парола.</p>
            <ActionButton url="/api/auth/logout-all" body={{}} className="btn btn-sm" confirmText="изход навсякъде">
              Изход от всички устройства
            </ActionButton>
          </section>
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Backup и възстановяване</h2>
            <p>
              {providerOf(ctx.db) === "postgresql" ? (
                <>PostgreSQL: логически backup с <code>npm run pg:backup</code> и проверка чрез възстановяване в отделна база (<code>npm run pg:restore-check</code>) — виж docs/CUTOVER-AND-ROLLBACK.md. Render прави и собствени backup-и на платената база.</>
              ) : (
                <>Консистентен backup (SQLite <code>VACUUM INTO</code>, безопасно при WAL) в папка <code>backups/</code> (извън Git), с автоматична проверка чрез възстановяване във временна база: <code>npm run backup</code>.</>
              )}
            </p>
            <p className="mt-1 text-muted">Активната база никога не се презаписва автоматично. Ръчно възстановяване: спри app/worker, запази текущия файл, после замени — виж README.</p>
          </section>
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Импорт / експорт</h2>
            <div className="flex flex-wrap gap-2">
              <Link href="/leads/import" className="btn btn-sm">
                Импорт CSV
              </Link>
              <a href="/api/export/leads" className="btn btn-sm">
                Експорт CSV (само собствени CRM данни)
              </a>
            </div>
          </section>
          <section className="card p-3">
            <h2 className="mb-1 text-base font-semibold">Retention и DNC</h2>
            <p className="whitespace-pre-wrap">{settings.retentionNotes}</p>
            <p className="mt-1 text-muted">
              Активни DNC: {dncCount}. DNC записите и минималните идентификатори се пазят, за да работи потискането; пълно заличаване би отслабило бъдещото разпознаване (документирано в docs/SECURITY.md). Hash на телефон не е анонимизация.
            </p>
            <Link href="/leads?tab=archived" className="btn btn-sm mt-2">
              Виж архивирани/блокирани
            </Link>
          </section>
        </div>
      )}
    </>
  );
}
