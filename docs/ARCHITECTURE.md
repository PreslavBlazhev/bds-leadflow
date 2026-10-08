# Архитектура — BDS LeadFlow

## Слоеве

```
src/app/(app)/*        UI (Next.js App Router, server components) — само четене + рендер
src/components/        UI компоненти; client/* за интерактивност (fetch към собствения API)
src/app/api/*          Route handlers: auth + CSRF/origin + Zod → application services
src/domain/*           Application services и домейн правила (един код за UI, worker, scripts, тестове)
src/lib/*              env (Zod, fail-closed), db (Prisma, режим, tx retry), time (Europe/Sofia), auth
src/providers/*        Външни адаптери: candidates (Demo/B2B/Google Places), delivery (Web Push/SMTP), webAudit (SSRF-safe)
src/worker/*           Отделен процес: scheduler tick + outbox dispatcher
scripts/*              CLI: setup, owner:create, migrate, seed, backup, dry-run, next-day
prisma/                schema.prisma + migrations (2)
```

Всяко действие минава през `Ctx = { db, clock, mode, actor }`. Часовникът се подава отвън (injected): в тестовете е фиксиран, в demo е системното време + `demoDayOffset`, в real е системното време.

## Основни таблици

| Модел | Роля |
| --- | --- |
| `SystemMeta` | Режимът на DB файла (demo/real) и demo offset — fail-closed |
| `User`, `Session`, `LoginAttempt` | Един owner (`ownerSlot` UNIQUE), сесии с sha256 token, rate limit |
| `Business` | Каноничен lead; `mergedIntoId` при сливане; `firstIssuedAt`, `contactHistoryState`, `reviewStatus`, `score` (кеш) |
| `BusinessIdentifier` | Aliases: PHONE / DEMO_PHONE / DOMAIN / EIK / PLACE_ID / NAME_CITY (история, не се трие) |
| `DuplicateCandidate` | Конфликти за review (OPEN/MERGED/DISTINCT) |
| `SourceEvidence`, `WebsiteAudit`, `BusinessReview` | Provenance и разрешения; доказателства за сайта; избрани отзиви (demo маркирани) |
| `ScoreEvaluation` | Snapshot на оценката при издаване (rule version + breakdown) |
| `Activity` | CALL / CONTACT_OTHER / NOTE / MEETING / STATUS_CHANGE / DIAL_INTENT / IMPORTED_HISTORY / OFFER; `idempotencyKey` UNIQUE |
| `PipelineHistory` | Всяко преминаване между етапи |
| `DailyBatch` (`localDate` UNIQUE), `DailyBatchItem` (`businessId` UNIQUE, `(batchId, position)` UNIQUE) | Ledger на новите разпределения |
| `FollowUp`, `Offer`, `Client` (`businessId` UNIQUE), `ReceivedPayment` | Workflow |
| `Suppression` | DNC и INVALID_PHONE на ниво бизнес и на ниво идентификатор; `liftedAt` + причина |
| `AppSettings` | JSON, валидиран със Zod |
| `PushSubscription`, `NotificationOutbox` (`dedupeKey` UNIQUE), `DeliveryAttempt`, `DailyAcknowledgement` (`localDate` UNIQUE) | Известия |
| `JobRun` (`key` UNIQUE) | Lease, attempts, retry, late |
| `ImportBatch`, `ImportRowIssue`, `AuditLog`, `Counter` | Импорт, одит, броячи |

## Инварианти (в DB, не само във frontend)

1. **Нов само веднъж:** `DailyBatchItem.businessId UNIQUE` и `firstIssuedAt` се задава само ако е NULL (`updateMany where firstIssuedAt=null`, проверка count=1 в транзакцията).
2. **Един списък на дата:** `DailyBatch.localDate UNIQUE`. При конкурентна заявка: P2002, после повторно четене и връщане на съществуващия.
3. **Поредността не се подменя:** `(batchId, position) UNIQUE`. Допълването на частичен списък продължава номерацията.
4. **Без двойна дейност:** `Activity.idempotencyKey UNIQUE`. Резултатът и всички side effects са в една транзакция.
5. **Won не се дублира:** `Client.businessId UNIQUE` (upsert).
6. **Merge не губи потискане:** суспресиите се копират към каноничния запис; взема се най-ранната issued дата и най-строгата история.
7. **Eligibility се проверява наново вътре в транзакцията** при всяко публикуване (`src/domain/eligibility.ts` е единствената дефиниция).

Concurrency: SQLite + `connection_limit=1` за всеки процес. Заявките в един процес се подреждат. Между процесите (web и worker) защитават `busy_timeout=8000`, retry при `SQLITE_BUSY` в `tx()` и UNIQUE constraints. Тестът T05 проверява това с два отделни DB клиента.

## Дневен цикъл (scheduler + outbox)

1. `prepare:<date>` след `prepareTime` (07:00). В demo DemoProvider попълва резерва до `reserveTarget`. В real live discovery е BLOCKED.
2. `publish:<date>` след `publishTime` (08:00): `publishDailyBatch` (една транзакция) прави eligibility, scoring, квоти, items и `firstIssuedAt`, плюс outbox записи `push:daily:<date>` и `email:fallback:<date>` със `notBefore = max(scheduledAt, publishedAt) + 30 мин`.
3. Worker-ът обработва outbox. Всеки запис се „заявява“ с условен UPDATE и lease 2 мин. По време на HTTP/SMTP не е отворена DB транзакция. Push се разпраща към всички активни устройства, като за всяко се записва `DeliveryAttempt`. 404/410 маркира устройството като изтекло.
4. Fallback имейл: точно преди изпращане се проверява `DailyAcknowledgement`. Ако е отворен, статусът става `acknowledged` и имейл не тръгва. Ако няма устройства или всички окончателно са отказали, имейлът става due веднага.
5. Jobs: уникален ключ, lease 5 мин., до 4 опита с експоненциален backoff. Изтекъл lease се поема от следващия worker.
6. Catch-up: само текущата локална дата, с `late=true`. За минали дни нищо не се генерира.

Времето се смята с `Intl` за IANA `Europe/Sofia`. Тестовете покриват 29.03.2026 и 25.10.2026.

## Ограничения за бъдещ hosting

- SQLite е за един процес/една машина. Multi-instance изисква PostgreSQL. Това **не е само смяна на URL**: Prisma provider, миграции (нов baseline), типове DateTime/Float, `connection_limit`, advisory locks вместо file lock, `VACUUM INTO` → `pg_dump`.
- Worker-ът трябва да работи постоянно (always-on). Безплатен или „спящ“ hosting не гарантира 08:00.
- Нужен е HTTPS (за push, secure cookies и PWA на телефон).
- `next start` и worker-ът са два процеса. Нужен е process manager (systemd, pm2 или платформен worker).
