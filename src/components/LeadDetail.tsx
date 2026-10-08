import Link from "next/link";
import type { ReactNode } from "react";
import { ACTIVITY_LABELS, CATEGORY_LABELS, HISTORY_LABELS, PRIOR_CONTACT_LABELS, PRIOR_CONTACT_SOURCE_LABELS, SOURCE_LABELS, OFFER_STATUS_LABELS, OUTCOME_LABELS, STAGE_LABELS, WEBSITE_STATUS_LABELS, type ActivityType, type OfferStatus, type Outcome, type Stage } from "@/domain/constants";
import { formatPhone } from "@/domain/identity";
import type { LeadDetailData } from "@/domain/leadDetail";
import { RULE_LABELS } from "@/domain/scoring";
import { fmtDate, fmtDateTime, localDateOf, toLocalInput } from "@/lib/time";
import { noAnswerRetryAt } from "@/domain/activeList";
import { DialButton, LeadActions } from "./client/LeadActions";
import { OutcomeForm } from "./client/OutcomeForm";
import { Badge, money, StateBadge } from "./ui";

const U = <span className="text-muted">Неизвестно</span>;
const NC = <span className="text-muted">Непроверено</span>;

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,38%)_1fr] gap-2 py-1 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children ?? U}</dd>
    </div>
  );
}

function Block({ title, children, n }: { title: string; children: ReactNode; n: number }) {
  return (
    <section className="border-t border-line py-3" aria-label={title}>
      <h3 className="mb-1 text-sm font-semibold">
        <span className="tabular mr-1 text-muted">{n}.</span>
        {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

function ExtLink({ href }: { href: string | null }) {
  if (!href) return null;
  // Само http/https (валидирано при запис); demo домейни .invalid не водят никъде.
  const demo = href.includes(".example.invalid");
  return demo ? (
    <span className="break-all">
      {href} <Badge tone="demo">ДЕМО адрес</Badge>
    </span>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all">
      {href}
    </a>
  );
}

export function LeadDetail({ d, now, closeHref }: { d: LeadDetailData; mode: "demo" | "real"; now: Date; closeHref?: string }) {
  const { b } = d;
  const audit = b.audits[0];
  const issues: string[] = audit ? JSON.parse(audit.issues) : [];
  const openOffers = b.offers.filter((o) => o.status === "DRAFT" || o.status === "SENT");
  const blocked = d.dnc ? "Контактът е с „Не се свързвай повече“." : b.mergedIntoId ? "Записът е слят в друг." : null;
  const dialReason = d.dnc
    ? "DNC — набирането е блокирано."
    : d.invalidPhone
      ? "Телефонът е маркиран като невалиден."
      : b.isDemo || b.phoneKind === "DEMO_SYNTHETIC"
        ? "Демо запис: синтетичните номера не се набират."
        : b.phoneKind !== "E164"
          ? "Няма валиден служебен номер."
          : null;
  return (
    <article className="card bg-panel p-4" aria-label={`Детайли: ${b.name}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{b.name}</h2>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone="info">{STAGE_LABELS[b.pipelineStage as Stage] ?? b.pipelineStage}</Badge>
            {d.dnc && <Badge tone="bad">■ DNC — не се свързвай</Badge>}
            {d.invalidPhone && <Badge tone="bad">■ Невалиден номер</Badge>}
            {b.reviewStatus !== "NONE" && <Badge tone="warn">▲ {b.reviewStatus === "DUPLICATE_REVIEW" ? "Проверка за дубликат" : "За проверка"}</Badge>}
            {b.status !== "ACTIVE" && <Badge>{b.status === "ARCHIVED" ? "Архивиран" : "Затворен"}</Badge>}
            {b.isDemo && <StateBadge state="DEMO_SIMULATED" title="Синтетичен demo запис" />}
            {b.callPriority && <Badge tone={b.callPriority === "A" ? "ok" : "info"}>Приоритет {b.callPriority}</Badge>}
            {b.priorContact === "CALLED_BEFORE_IMPORT" && <Badge tone="warn">▲ {PRIOR_CONTACT_LABELS.CALLED_BEFORE_IMPORT}</Badge>}
            {d.eligibility.eligible ? <Badge tone="ok">● Допустим за нов списък</Badge> : <Badge>Не е допустим за нов</Badge>}
          </div>
        </div>
        {closeHref && (
          <Link href={closeHref} className="btn btn-sm" aria-label="Затвори детайлите">
            ✕
          </Link>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {dialReason ? (
          <span className="flex flex-col">
            <button type="button" className="btn btn-sm" disabled>
              Позвъни
            </button>
            <span className="text-xs text-muted">{dialReason}</span>
          </span>
        ) : (
          <DialButton businessId={b.id} />
        )}
        <Link href={`/calls?id=${b.id}`} className="btn btn-sm">
          Отвори в Обаждания
        </Link>
        {d.dnc ? (
          <span className="flex flex-col">
            <button type="button" className="btn btn-sm" disabled>
              Нова оферта
            </button>
            <span className="text-xs text-muted">DNC — офертите са блокирани.</span>
          </span>
        ) : (
          <Link href={`/offers?new=${b.id}`} className="btn btn-sm">
            Нова оферта
          </Link>
        )}
      </div>

      <Block n={1} title="Идентификатори">
        <Row k="Lead ID">
          <code className="text-xs">{b.ref}</code> <span className="text-xs text-muted">({b.id})</span>
        </Row>
        <Row k="Canonical business ID">
          {b.mergedInto ? (
            <Link href={`/leads/${b.mergedInto.id}`}>
              {b.mergedInto.ref} (слят)
            </Link>
          ) : (
            <code className="text-xs">{b.id}</code>
          )}
        </Row>
      </Block>

      <Block n={2} title="Име">
        <Row k="Име">{b.name}</Row>
        <Row k="Юридическо име">{b.legalName ?? U}</Row>
        <Row k="ЕИК">{b.eik ?? U}</Row>
      </Block>

      <Block n={3} title="Град, адрес, категория">
        <Row k="Град">{b.city}</Row>
        {b.district && <Row k="Квартал/район">{b.district}</Row>}
        <Row k="Адрес">{b.address ?? U}</Row>
        <Row k="Категория">
          {CATEGORY_LABELS[b.category] ?? b.category}
          {b.sourceCategory && <span className="text-muted"> · в източника: {b.sourceCategory}{b.subcategory ? ` / ${b.subcategory}` : ""}</span>}
        </Row>
        {b.openingHours && (
          <Row k="Работно време (по източника)">
            <span className="whitespace-pre-line">{b.openingHours}</span>
          </Row>
        )}
      </Block>

      <Block n={4} title="Основен служебен телефон">
        <Row k="Оригинал">{b.phoneKind === "DEMO_SYNTHETIC" ? <span>{formatPhone(b.phoneNormalized, b.phoneKind)}</span> : (b.phoneRaw ?? U)}</Row>
        <Row k="Нормализиран">{b.phoneNormalized ? <code className="text-xs">{b.phoneKind === "DEMO_SYNTHETIC" ? `${b.phoneNormalized} (синтетичен namespace)` : b.phoneNormalized}</code> : U}</Row>
        <Row k="Проверен">{b.phoneVerified ? "Да" : NC}</Row>
        {b.phone2Raw && <Row k="Допълнителен телефон">{b.phone2Normalized ?? b.phone2Raw}</Row>}
      </Block>

      <Block n={5} title="Други служебни контакти">
        <Row k="Имейл">{b.email ?? U}</Row>
      </Block>

      <Block n={6} title="Лице за контакт">
        <Row k="Име/роля">{b.contactPersonName ? `${b.contactPersonName}${b.contactPersonRole ? ` — ${b.contactPersonRole}` : ""}` : U}</Row>
        <Row k="Източник">{b.contactPersonSource ?? U}</Row>
      </Block>

      <Block n={7} title="Сайт и връзки">
        <Row k="Сайт">{b.website ? <ExtLink href={b.website} /> : U}</Row>
        <Row k="Социална връзка">{b.socialUrl ? <ExtLink href={b.socialUrl} /> : U}</Row>
        <Row k="Активна соц. страница">{b.socialActive === null ? NC : b.socialActive ? "Да" : "Не"}</Row>
        <Row k="Профил/карта">{b.mapsUrl ? <ExtLink href={b.mapsUrl} /> : U}</Row>
        {b.facebookUrl && <Row k="Facebook"><ExtLink href={b.facebookUrl} /></Row>}
        {b.instagramUrl && <Row k="Instagram"><ExtLink href={b.instagramUrl} /></Row>}
        {b.otherProfileUrl && <Row k="Друг профил/платформа"><ExtLink href={b.otherProfileUrl} /></Row>}
      </Block>

      <Block n={8} title="Рейтинг и избрани отзиви">
        <Row k="Рейтинг">{b.rating !== null ? `${b.rating.toFixed(1)} (${b.reviewCount ?? "?"} отзива)` : <span className="text-muted">Няма данни</span>}</Row>
        <Row k="Източник на рейтинга">{b.ratingSource ?? U}</Row>
        {b.recentReviewNote && <Row k="Скорошен отзив (по източника)">{b.recentReviewNote}</Row>}
        {b.reviews.length > 0 && (
          <div className="mt-1 space-y-2">
            <div className="text-xs text-muted">Избрани отзиви (не всички)</div>
            {b.reviews.map((r) => (
              <blockquote key={r.id} className="rounded-md border border-line p-2 text-sm">
                <p className="whitespace-pre-wrap">{r.text}</p>
                <footer className="mt-1 text-xs text-muted">
                  9. {r.author} · {r.reviewDate ? fmtDate(r.reviewDate) : "без дата"} · източник: {r.source} {r.url ? <ExtLink href={r.url} /> : "· без линк"} {r.isDemo && <Badge tone="demo">ДЕМО отзив</Badge>}
                </footer>
              </blockquote>
            ))}
          </div>
        )}
      </Block>

      <Block n={10} title="Статус на сайта">
        <Row k="Статус">{WEBSITE_STATUS_LABELS[b.websiteStatus] ?? b.websiteStatus}</Row>
        {b.websiteObservation && <Row k="Наблюдение в източника">„{b.websiteObservation}“ <span className="text-muted">(не е категорично „няма сайт“)</span></Row>}
      </Block>

      <Block n={11} title="Оценка на сайта">
        {audit ? (
          <>
            <Row k="Резултат">
              {audit.result} {audit.synthetic && <Badge tone="demo">синтетично доказателство</Badge>}
            </Row>
            <Row k="Дата">{fmtDateTime(audit.checkedAt)}</Row>
            <Row k="HTTPS / viewport / контакти">
              {[audit.https, audit.hasViewport, audit.contactVisible].map((x, i) => (
                <span key={i} className="mr-2">
                  {["HTTPS", "viewport", "контакти"][i]}: {x === null ? "неизвестно" : x ? "да" : "не"}
                </span>
              ))}
            </Row>
            <Row k="Наблюдавани проблеми">{issues.length ? issues.join("; ") : "Няма документирани"}</Row>
            <Row k="Доказателство">{audit.evidence}</Row>
          </>
        ) : (
          <Row k="Проверка">{NC}</Row>
        )}
      </Block>

      <Block n={12} title="Предложима услуга">
        <Row k="Услуга">{b.suggestedService ?? U}</Row>
        <Row k="Примерна стойност">{b.estimatedValueCents !== null ? `${money(b.estimatedValueCents)} — прогноза, не оферта` : U}</Row>
      </Block>

      <Block n={13} title={`Score ${d.score.score}/100 — защо`}>
        <ul className="space-y-1 text-sm">
          {d.score.lines.map((l, i) => (
            <li key={i} className="flex gap-2">
              <span className={`tabular w-10 shrink-0 text-right ${l.applied ? (l.points >= 0 ? "text-ok" : "text-bad") : "text-muted"}`}>{l.applied ? (l.points > 0 ? `+${l.points}` : l.points) : "0"}</span>
              <span>
                <span className="font-medium">{RULE_LABELS[l.rule] ?? l.rule}:</span> <span className="text-muted">{l.why}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-muted">
          Сума {d.score.raw} → ограничена в [0,100]. Правила {d.score.ruleVersion}. Score е търговски приоритет, не оценка на платежоспособност.
          {b.scores[0] && ` Snapshot при издаване: ${b.scores[0].score} (${fmtDate(b.scores[0].computedAt)}).`}
        </p>
      </Block>

      <Block n={14} title="Начало на разговор и въпроси">
        <div className="mb-1">{d.pitch.isTemplate ? <Badge tone="info">Предложение по шаблон</Badge> : <Badge>Редактирано от мен</Badge>}</div>
        <p className="text-sm whitespace-pre-wrap">{d.pitch.opening}</p>
        <p className="mt-2 text-sm whitespace-pre-wrap text-muted">{d.pitch.questions}</p>
      </Block>

      <Block n={15} title="Pipeline, резултат, бележки, история">
        <Row k="Етап">{STAGE_LABELS[b.pipelineStage as Stage]}</Row>
        <Row k="Последен резултат">{b.lastOutcome ? OUTCOME_LABELS[b.lastOutcome as Outcome] : "Няма"}</Row>
        <Row k="История на контакт">{HISTORY_LABELS[b.contactHistoryState]}</Row>
        {b.priorContact && (
          <Row k="Преди импорта">
            {PRIOR_CONTACT_LABELS[b.priorContact] ?? b.priorContact}
            <span className="block text-xs text-muted">
              Произход: {PRIOR_CONTACT_SOURCE_LABELS[b.priorContactSource ?? ""] ?? b.priorContactSource ?? "—"} · записано {fmtDateTime(b.priorContactRecordedAt)}
              {b.priorContact === "CALLED_BEFORE_IMPORT" ? " · дата и резултат на обаждането: неизвестни" : ""}
            </span>
          </Row>
        )}
        <Row k="Бележки">{b.notes ? <span className="whitespace-pre-wrap">{b.notes}</span> : <span className="text-muted">Няма</span>}</Row>
        <div className="mt-2">
          <div className="text-xs text-muted">История ({b.activities.length})</div>
          {b.activities.length === 0 ? (
            <p className="text-sm text-muted">Няма записани дейности.</p>
          ) : (
            <ol className="mt-1 space-y-1.5 text-sm">
              {b.activities.map((a) => (
                <li key={a.id} className="border-l-2 border-line pl-2">
                  <span className="tabular text-xs text-muted">{fmtDateTime(a.occurredAt)}</span> · {ACTIVITY_LABELS[a.type as ActivityType] ?? a.type}
                  {a.outcome && <strong> — {OUTCOME_LABELS[a.outcome as Outcome]}</strong>}
                  {a.type === "CALL" && <span className="text-xs text-muted"> ({a.callConnected ? "с разговор" : "без разговор"})</span>}
                  {a.note && <div className="text-muted whitespace-pre-wrap">{a.note}</div>}
                </li>
              ))}
            </ol>
          )}
        </div>
        {b.pipelineHistory.length > 0 && (
          <div className="mt-2 text-xs text-muted">
            Етапи:{" "}
            {b.pipelineHistory.map((p) => `${fmtDate(p.at)} ${STAGE_LABELS[p.fromStage as Stage]}→${STAGE_LABELS[p.toStage as Stage]}`).join(" · ")}
          </div>
        )}
        {b.offers.length > 0 && (
          <div className="mt-2 text-sm">
            Оферти:{" "}
            {b.offers.map((o) => (
              <span key={o.id} className="mr-2">
                {o.service} — {money(o.oneTimeCents)} ({OFFER_STATUS_LABELS[o.status as OfferStatus]})
              </span>
            ))}
          </div>
        )}
        {b.client && (
          <div className="mt-1 text-sm">
            Клиент: <Link href="/clients">{b.client.service}</Link> — договорено {money(b.client.agreedOneTimeCents)}
          </div>
        )}
      </Block>

      <Block n={16} title="Дати">
        <Row k="Последен контакт">{fmtDateTime(b.lastContactAt)}</Row>
        <Row k="Следващо действие">{b.nextAction ?? (b.followUps.find((f) => f.status === "OPEN")?.reason || "—")}</Row>
        <Row k="Дата на следващо">{fmtDateTime(b.nextActionAt ?? b.followUps.find((f) => f.status === "OPEN")?.dueAt ?? null)}</Row>
        <Row k="Първо издаване">{b.firstIssuedAt ? `${fmtDateTime(b.firstIssuedAt)}${b.batchItem ? ` (списък ${fmtDate(b.batchItem.batch.localDate)})` : ""}` : "Не е издаван"}</Row>
      </Block>

      <Block n={17} title="Източник и разрешения">
        <Row k="Provider">{SOURCE_LABELS[b.source] ?? b.source}</Row>
        <Row k="Референция">{b.sourceRef ?? U}</Row>
        {b.sourceName && (
          <Row k="Файл / лист / №">
            {b.sourceName} / {b.sourceSheet ?? "—"} / №{b.sourceRowNo ?? "—"}
          </Row>
        )}
        {b.sourceCheckedOn && <Row k="Дата на проверката (източник)">{fmtDate(b.sourceCheckedOn)}</Row>}
        {b.importedAt && <Row k="Дата на импорта">{fmtDateTime(b.importedAt)} <span className="text-muted">(не е нова проверка)</span></Row>}
        {b.confidenceLabel && <Row k="Увереност (източник)">{b.confidenceLabel}</Row>}
        <Row k="Source URL">{b.sourceUrl ? <ExtLink href={b.sourceUrl} /> : U}</Row>
        <Row k="fetched_at / verified_at">
          {fmtDateTime(b.fetchedAt)} / {b.verifiedAt ? fmtDateTime(b.verifiedAt) : NC}
        </Row>
        <Row k="Confidence">{b.confidence !== null ? b.confidence.toFixed(2) : U}</Row>
        <Row k="Право за използване">{b.sourceUsageConfirmed ? "Потвърдено" : "Не е потвърдено"}</Row>
        {b.evidence.map((e) => (
          <Row key={e.id} k={`Поле ${e.field}`}>
            съхранение: {e.storageAllowed ? "разрешено" : "НЕ"} · производна употреба: {e.derivedUseAllowed ? "да" : "не"}
            {e.synthetic ? " · синтетично" : ""}
            {e.note ? ` · ${e.note}` : ""}
          </Row>
        ))}
      </Block>

      <Block n={18} title="Идентичност, DNC, допустимост">
        <Row k="Aliases">
          {b.identifiers.map((i) => (
            <code key={i.id} className="mr-1 inline-block text-xs">
              {i.type}:{i.type.includes("PHONE") && b.phoneKind === "DEMO_SYNTHETIC" ? i.value : i.value}
            </code>
          ))}
        </Row>
        <Row k="Възможни дубликати">
          {d.dupes.length === 0
            ? "Няма"
            : d.dupes.map((x) => (
                <span key={x.id} className="mr-2">
                  <Link href={`/leads/${x.other.id}`}>{x.other.ref}</Link> ({x.matchType}, {x.status})
                </span>
              ))}
        </Row>
        <Row k="Потискания">
          {b.suppressions.length === 0
            ? "Няма"
            : b.suppressions
                .filter((s) => !s.identifierType)
                .concat(b.suppressions.filter((s) => s.identifierType && s.type === "INVALID_PHONE"))
                .map((s) => (
                  <div key={s.id}>
                    {s.type} — {s.reason} ({fmtDate(s.createdAt)}){s.liftedAt ? ` · премахнато ${fmtDate(s.liftedAt)}: ${s.liftedReason}` : ""}
                  </div>
                ))}
        </Row>
        <Row k="Допустимост за нов">
          {d.eligibility.eligible ? (
            <span className="text-ok">Допустим</span>
          ) : (
            <ul className="list-disc pl-4">
              {d.eligibility.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Row>
      </Block>

      <section className="border-t border-line pt-3" aria-label="Записване на резултат">
        <h3 className="mb-2 text-sm font-semibold">Запиши резултат</h3>
        <OutcomeForm
          businessId={b.id}
          blockedReason={blocked}
          packages={d.settings.packages}
          openOffers={openOffers.map((o) => ({ id: o.id, service: o.service, oneTimeCents: o.oneTimeCents, monthlyCents: o.monthlyCents }))}
          today={localDateOf(now)}
          compact
          retryDefault={{ local: toLocalInput(noAnswerRetryAt(now, d.settings)), workdays: d.settings.noAnswerRetryWorkdays }}
        />
      </section>

      <LeadActions
        businessId={b.id}
        dnc={d.dnc}
        archived={b.status === "ARCHIVED"}
        historyUnknown={b.contactHistoryState === "UNKNOWN"}
        dupes={d.dupes.filter((x) => x.status === "OPEN").map((x) => ({ id: x.other.id, ref: x.other.ref, name: x.other.name }))}
        inReview={b.reviewStatus === "DUPLICATE_REVIEW"}
        edit={{
          name: b.name,
          city: b.city,
          address: b.address ?? "",
          phone: b.phoneRaw ?? "",
          website: b.website ?? "",
          socialUrl: b.socialUrl ?? "",
          contactPersonName: b.contactPersonName ?? "",
          contactPersonRole: b.contactPersonRole ?? "",
          openingLine: b.openingLine ?? "",
          questions: b.questions ?? "",
          notes: b.notes ?? "",
        }}
      />
    </article>
  );
}
