# BDS LeadFlow — подготовка за GitHub и Render (отчет A–M)

Дата: 08–09.10.2026. Задание: `C:\Users\The King\Desktop\BDS-LeadFlow-Production-Prompt.md`. Проект: `C:\Users\The King\Desktop\Sites\15. BDS LeadFlow`.

Статуси: **реално проверено локално** · **реализирано, но не проверено на Render/телефон** · **блокирано**. Нищо не е публикувано: няма push, GitHub remote, Render ресурси, DNS, реални доставки, Google Places заявки или контакт с клиенти.

---

## A. Резултат

**Кодът е подготвен и PostgreSQL runtime е реално проверен локално** с истински PostgreSQL 18.6 (портативен, отделен тестов сървър). Render и телефонът не са проверени (нищо не е създадено).

| Какво | Статус |
| --- | --- |
| PostgreSQL поддръжка: генерирана схема, отделна миграционна история, два Prisma клиента, един набор бизнес услуги | реално проверено локално |
| Всички интеграционни тестове (вкл. активен списък, „Не отговори“, DNC, outbox, конкуренция с отделни процеси) върху PostgreSQL | реално проверено локално — 77 PASS, 1 пропуснат (SQLite-специфичен backup) |
| Пробен пренос на копие от работната SQLite база → PostgreSQL, независимо сверяване, повторен импорт = 0 промени | реално проверено локално — PASS |
| Production команди `start:web` + `worker:start` (APP_ENV=production) срещу една PostgreSQL база, нов build + рестарт | реално проверено локално (синтетична база) |
| Worker: schema readiness, heartbeat в DB, gates, SIGTERM/IPC спиране, backoff при прекъсната DB връзка | реално проверено локално (реален SIGTERM сигнал — само в Linux; виж J) |
| Push разписки, правило за резервния имейл, остарели известия, cutover задържане, dry-run на истинските адаптери | реално проверено локално |
| Production достъп: owner защита, Secure cookie, Origin без Host доверие, proxy IP, liveness/readiness | реално проверено локално (production профил на http://127.0.0.1) |
| `render.yaml` | валидиран локално срещу официалната schema; на Render — не |
| PostgreSQL backup/restore | реално проверено локално |
| GitHub Actions CI | написан; не е изпълнен (няма хранилище в GitHub) |
| Доставка на push до телефон, реален SMTP | реализирано, но не проверено на Render/телефон |
| `docker-compose.test.yml` | блокирано: Docker не е инсталиран (не е инсталиран глобално по изискване); използван е портативен PostgreSQL със същия порт и credentials |

Локалната система работи на **http://localhost:3015** със същия owner акаунт и парола (паролата не е пипана). Работната база получи само добавяща миграция (backup преди това). Реалните 216 бизнеса, историята на 35-те, DNC, списъците и правилата за активния списък са непроменени; gate за първия реален списък пт 09.10.2026 08:00 е `ok`.

## B. Архитектура

```
GitHub (частно, main) ──CI (checksPass)──▶ Render Blueprint (frankfurt)
                                            ├─ web  bds-leadflow-web     next start 0.0.0.0:$PORT, /api/health, preDeploy: db:deploy
                                            ├─ worker bds-leadflow-worker tsx src/worker/index.ts (постоянен)
                                            └─ PostgreSQL 18 bds-leadflow-db (вътрешен URL, ipAllowList: [])
Телефон (PWA, HTTPS) ◀─Web Push (VAPID)── worker ──SMTP──▶ резервен имейл до owner
```

- **Web**: owner вход (Argon2id + DB сесии), всички CRM екрани/API зад `requirePageOwner`/`api()`. Публични: login, `/api/health`, `/api/ready`, PWA ресурси, `/api/push/receipt` (token).
- **PostgreSQL**: единственото постоянно хранилище в production; web и worker споделят една база (настройки, списъци, обаждания, outbox, heartbeat).
- **Worker**: един процес, tick на 30 s (Europe/Sofia се изчислява в кода чрез IANA зона); подготовка (07:00 по подразбиране) и публикуване (08:00) по правилата за активния списък; outbox доставки. Gates: `SCHEDULER_ENABLED`, `DELIVERIES_ENABLED` (в шаблона `false`).
- **GitHub**: кодът; базата не е в Git. При промяна на кода → CI → Render deploy; обажданията и списъците променят само базата.
- **Уведомяване**: outbox в същата транзакция като публикуването; push към регистрираните устройства; резервен имейл по точно правило (H).

## C. Променени файлове

**Нови**
- `prisma/postgresql/schema.prisma` (генериран), `prisma/postgresql/migrations/20261009000000_init/migration.sql` + `migration_lock.toml` — PostgreSQL схема и отделна история с частичен unique индекс и CHECK ограничения.
- `prisma/migrations/20261009000000_production_prep/` — SQLite: `WorkerHeartbeat`, полета за разписки (`receiptTokenHash`, `swReceivedAt`, `openedAt`), отбелязване на пренос в `SystemMeta`, частичен unique индекс за повторните обаждания. Само добавя.
- `src/lib/prismaClients.ts` — избор на клиент по схемата на URL; `src/lib/schemaVersion.ts` — точно съвпадение на миграциите (ready); `src/lib/requestGuards.ts` — Origin/IP проверки.
- `src/domain/migration.ts` — архив, канонично представяне, валидиране, атомарен импорт, сверяване; `src/domain/workerState.ts` — heartbeat и честно състояние.
- `src/app/api/ready`, `src/app/api/push/receipt`, `src/app/api/auth/logout-all`; `src/instrumentation.ts` + `src/instrumentation-node.ts` — проверка на конфигурацията при старт.
- Скриптове: `prisma-pg-schema.mjs`, `prisma-pg.mjs`, `pg-local.mjs`, `test-pg.mjs`, `start-web.mjs`, `migrate-data.ts`, `pg-backup.ts`, `notifications-release.ts`, `validate-render-yaml.mjs`.
- `render.yaml`, `.env.production.example`, `.node-version`, `docker-compose.test.yml`, `.github/workflows/ci.yml`.
- Тестове: `tests/integration/production.test.ts` (13), `pgTest.ts`, `fixtures/tick-child.ts`, `tests/e2e/01b-production.spec.ts` (2).
- Документи: този отчет, `RENDER-SETUP.md`, `DATABASE-MIGRATION.md`, `CUTOVER-AND-ROLLBACK.md`, `NOTIFICATIONS-SETUP.md`.

**Променени**
- `prisma/schema.prisma` — нови модели/полета (горе) и бележка за източника на истината.
- `src/lib/db.ts` — PostgreSQL клиент и пул по роля, `getRawDb` за health/ready, retry при PostgreSQL конфликти, `lockKey` (transaction-scoped advisory lock), `lockBusinessRow` (FOR UPDATE), unique проверка по код.
- `src/lib/env.ts` — `APP_ENV`, production правила (PostgreSQL, real, https, sslmode, без `accept_invalid_certs`, Render guard), gates, `ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS`, `WORKER_STALE_SECONDS`, `NOTIFY_DRY_RUN`; проверка на demo/test само по името на базата.
- `src/lib/server.ts`, `src/app/api/auth/login|logout` — Origin без Host в production, IP от доверения proxy, Secure cookie.
- `src/worker/index.ts` — schema/data readiness, gates, heartbeat, bounded backoff, SIGTERM (+IPC за Windows тестове), освобождаване на lease-ове.
- `src/domain/batch.ts` — advisory lock при публикуване, token за разписка; `outcomes.ts` — row lock; `notifications.ts` — разписки, правило за имейла, остарели, dry-run; `providers/delivery.ts` — dry-run на web-push/SMTP; `health.ts`, `backup.ts`.
- UI: Настройки (състояние на worker-а, „Активирай известията“, сесии, PostgreSQL backup текст), Днес (честен текст за worker), `PushManager.tsx`, `public/sw.js`.
- `scripts/db-migrate.ts` (PostgreSQL, режим чрез суров SQL), `run-e2e.mjs` + `playwright.config.ts` + `01-security.spec.ts` (T38 без нужда от `.env`), тестовите helpers (SQLite или PostgreSQL).
- `package.json` (скриптове, engines), `package-lock.json` (само engines), `.gitignore`, `eslint.config.mjs`, `README.md`, `docs/SECURITY.md`, `docs/PROGRESS.md`.

## D. Версии и зависимости

| | Преди | Сега |
| --- | --- | --- |
| Node | engines `^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0` | `.node-version` **24.21.0**, engines `>=24.21.0 <25` (Render default за нови услуги също е 24.21.0) |
| Prisma | 6.19.3 | 6.19.3 (без upgrade; втори генериран клиент от същата версия) |
| Next.js / React | 16.4.0 / 19.3.0 | без промяна |
| Vitest / Playwright / TypeScript | 3.2.7 / 1.63.0 / 6.0.3 | без промяна |
| PostgreSQL | — | Render 18; локално 18.6 (портативен, `.tools/`, извън Git) |

- **Зависимости**: не са добавяни, махани или обновявани. `package-lock.json` — само полето engines; `npm ci` с Node 24.21.0 минава.
- **Инструменти извън проекта**: портативни Node 24.21.0 (SHA256 сверен с nodejs.org) и PostgreSQL 18.6 (EnterpriseDB zip), ajv@8/ajv-formats/js-yaml в `.tools/validate` само за проверката на render.yaml. Нищо не е инсталирано глобално.
- **npm audit** (Node 24.21.0): production веригата има същите 3 high (deepmerge-ts през prisma 6.13–8.x), вече описани в `docs/SECURITY.md`; новото не добавя нищо. Dev веригата — без промяна.

## E. PostgreSQL схеми

- Източник на моделите: `prisma/schema.prisma`. `npm run db:pg:schema` сменя само generator/datasource; `db:pg:schema:check` (CI) отказва разминаване. Моделите, връзките и всички `@unique/@@unique/@@index` са идентични.
- Отделна PostgreSQL история (`prisma/postgresql/migrations`); SQLite историята (6 миграции) не е изтривана, не е правен reset.
- Допълнителни ограничения: частичен unique `FollowUp(activityId) WHERE kind='RETRY'` (и в двете бази); CHECK за единичните редове, режима, формата на местната дата, позициите, `processedAt/processedOutcome`, статусите на бизнес/follow-up/DNC/канал.
- Конкурентност (PostgreSQL): `pg_advisory_xact_lock` в транзакцията на публикуването (обвързан с нейната връзка), `SELECT … FOR UPDATE` на бизнеса при запис на резултат, conditional UPDATE claim/lease за jobs и outbox, unique: един списък на местна дата, бизнес само веднъж като нов, един outbox запис на ключ.
- Избор на режим: `DATABASE_URL` `file:` → SQLite, `postgresql://` → PostgreSQL. `APP_ENV=production` изисква PostgreSQL. Чиста база: `npm run db:deploy` (повторно → „No pending migrations“, проверено).

## F. Пренос на данни (пробен, без лични данни)

- Snapshot: **2026-10-08T20:37:42.575Z** (`VACUUM INTO` копие на работната база; самата база само прочетена). Архив v1: 31 таблици, 4082 реда, 209 KB, локално в `backups/migration/2026-10-08T20-37-42-543Z/` (извън Git).
- Импорт в disposable PostgreSQL: 4082 реда за 1,3 s в една транзакция. Сверяване **PASS**: 31/31 таблици ред по ред (каноничен вид: моменти UTC ms, числа, булеви, текст), 23 FK проверки със SQL — 0 осиротели, 0 sequences (текстови ID; броячът `Counter` е пренесен).
- Сверени бизнес факти (еднакви): 620 бизнеса; **216 реални**; **35 прозвънени преди импорта** (без измислени дата/резултат); **181 незвънени и допустими** — същият ред на подбор; 216 с дата на проверка **2026-09-15** (не е обновена); 5 списъка (04–08.10, демо), 125 участия, 45 обработени; реален активен списък към snapshot-а — няма; 7 отворени повторни обаждания; 3 DNC; 1 блокиран телефон; 1648 идентификатора; пари; настройки (свежест **30** — записаната стойност, не е увеличавана); owner потребител и паролен hash — идентични.
- Повторен импорт: 0 промени. Друг архив / непразна база / повреден архив / осиротяла връзка / нарушено ограничение по средата → отказ без нито един записан ред (тествано).
- Парола/сесии: hash-ът се пренася; сесиите не (нов вход със същата парола). Push абонаментите — отменени като история (нова регистрация). Неизпратени известия → `cutover_hold` (в snapshot-а: 0).
- Финалният export за live е отделна стъпка точно преди cutover.

## G. Scheduler

- Условия (непроменени, тествани и върху PostgreSQL): един активен реален списък до записан резултат за всеки контакт; нови списъци пн–пт в 08:00 Europe/Sofia; ако в 08:00 предишният не е приключен — без нов списък този ден; закъснял старт публикува само днешния; до 25, един на местна дата; подготовката не резервира; „Не отговори“ → след 2 (или 3) работни дни 08:00, ръчната дата има предимство.
- Часова зона: Intl/IANA `Europe/Sofia`, без OS timezone и фиксиран offset. Тествани 07:59:59/08:00:00 в лятно и зимно време, 00:30 местно = 21:30 UTC предния ден.
- Конкурентност: 2 отделни worker процеса + web заявка едновременно → 1 списък, 25 уникални допустими, 1 push + 1 имейл запис, 1 успешен job (SQLite и PostgreSQL).
- Рестарт: състоянието е само в базата (JobRun ключове, outbox, списъци). Нов build + рестарт на production процесите → същият списък, прогресът и задачите остават, нищо не се изпраща повторно.
- SIGTERM: спира приемането на работа, чака текущия tick (≤25 s), освобождава lease-овете, записва `stopped`, затваря DB. Временна DB грешка: експоненциален backoff до 5 мин, без спиране (PostgreSQL тест с прекъснати връзки).
- Heartbeat: таблица `WorkerHeartbeat` — последно успешно изпълнение, следваща проверка, състояние, последна грешка, gates. Праг `WORKER_STALE_SECONDS=180`. Зелено само при пресен heartbeat в състояние `ready`; иначе „проблем“ (schema, без данни, графикът изключен, грешка) или „не работи“.

## H. Push и имейл

- Код: стандартен Web Push (VAPID, `web-push`), service worker със scope `/` и относителни адреси, manifest `/today`, „Активирай известията“ след натискане, ясно състояние (неподдържан, не-HTTPS, отказан, неактивен абонамент, iPhone PWA), unsubscribe, сменен ключ/абонамент, 404/410 → изтекъл. Разписки: `shown` (обработено от service worker) и `clicked` (отворено от owner) отделно от `provider_accepted`.
- Резервен имейл: веднага при липса/отказ на push; иначе в max(планиран, действително публикуване) + N мин, ако дотогава owner не е отворил списъка и няма разписка „shown“. Приемането от доставчика не спира имейла. Пълно описание: `docs/NOTIFICATIONS-SETUP.md`.
- Dry-run/mock проверки: mock транспорти (успех, грешка, 404/410, закъснение); истинските адаптери с `NOTIFY_DRY_RUN` (VAPID подпис + криптиране, MIME) без мрежа; production профил: публикуване → няма устройства → имейл веднага → изграден, не изпратен.
- Остава за live тест: регистрация на телефона на HTTPS адреса, реален push (показване, разписка), реален SMTP и Inbox (SPF/DKIM).

## I. Достъп и тайни

- Owner защита на всички CRM страници/API (анонимно: 307 към login / 401; проверено и в production профил). Без регистрация, без автоматичен owner.
- Cookie: `Secure; HttpOnly; SameSite=lax` в production. Origin: само `APP_BASE_URL` + `ALLOWED_ORIGINS` (Host-съвпадащ, но неразрешен Origin → 403). Login rate limit по потребител и по IP от доверения proxy. „Изход от всички устройства“.
- Класификация (пълна: `.env.production.example`): secret — `DATABASE_URL`, `VAPID_PRIVATE_KEY` (worker), `SMTP_USER`, `SMTP_PASS` (worker); public — `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (web+worker, една стойност); config — останалите. Без тайни с `NEXT_PUBLIC_`; T38 проверява bundle-а с фалшиви тайни за всеки пуск.
- Git проверка: 236 файла за commit; няма `.env`, бази, backup-и, архиви, dump-ове, Excel, логове, `.verify`, `node_modules`; няма ключове/токени; 0 съвпадения с 861 стойности от реалните записи; screenshots — синтетични. Хранилището няма remote; историята не е пренаписвана.

## J. Тестове

Портативен PostgreSQL 18.6 на 127.0.0.1:54315 (`npm run pg:local -- start`), ICU en-US за rehearsal базата. Логове на чистото копие: `.verify/logs-prod/`.

| # | Команда / сценарий | Среда | Резултат |
| --- | --- | --- | --- |
| 1 | `npm ci` | чисто копие, Node 24.21.0 / npm 11.19.0 | PASS (exit 0; npm 11 предупреждава за install scripts, но клиентите са генерирани) |
| — | `db:pg:schema:check`, `typecheck`, `lint` | чисто копие Node 24 и основна папка Node 21.5 | PASS |
| — | `npm run test` (unit) | Node 24 и 21.5 | 35/35 PASS |
| — | `npm run test:integration` (SQLite) | Node 24 | 75 PASS, 3 пропуснати (само PostgreSQL) |
| — | `npm run test:pg` (PostgreSQL 18.6) | Node 24 | 77 PASS, 1 пропуснат (SQLite backup) |
| 1 | `npm run build` без `.env`, без `DATABASE_URL`/ключове | Node 24 | PASS; повторен build след UI поправка — PASS |
| — | `npm run test:e2e` (Chrome, desktop + mobile) | чисто копие, Node 24 | 15/15 PASS (финален пуск `2026-10-08T21-07-12-502Z`). По-ранни пускове: T38 изискваше `.env` (поправено); 1 провал от преминаване през полунощ по време на пуска (данните за 08.10, тестът на 09.10) — следващият пуск PASS |
| 2 | Чиста PostgreSQL база + повторно `db:deploy` | PostgreSQL | PASS |
| 3 | `start:web` + `worker:start` (APP_ENV=production) срещу една база; настройка от web → публикуване от worker | PostgreSQL, синтетична | PASS |
| 4 | Пробен пренос на копие от реалната база | PostgreSQL | PASS |
| 5 | Повреден/невалиден архив, грешка по средата, повторен импорт | PostgreSQL | PASS |
| 6–7 | 2 worker процеса + web; изключени прозвънени/DNC/издадени/демо/общ телефон | SQLite и PostgreSQL | PASS |
| 8–11 | 22/25, ден/рестарт, след 08:00, пт–пн, „Не отговори“ пт→вт, 3 дни, ръчна дата, повторен запис, DNC, свежест | SQLite и PostgreSQL; „Не отговори“ и през production web API | PASS |
| 12 | Europe/Sofia DST, 07:59/08:00, UTC разминаване | инжектиран часовник | PASS |
| 13 | Рестарт около публикуване/outbox (T28), временна DB грешка | PostgreSQL | PASS |
| 13 | SIGTERM на worker | Windows: IPC към същия handler — PASS; **реален POSIX SIGTERM — не е изпълнен** (Windows няма сигнали за дъщерни процеси; ще мине в Linux CI) |
| 14 | Mock push/email, 404/410, fallback време, закъсняло публикуване, dry-run без мрежа | SQLite и PostgreSQL | PASS |
| 15 | Анонимен/owner достъп, Secure cookie, Origin в production профил | curl + тестове + E2E | PASS |
| 16 | PWA ресурси, deep link `/today`, без кеш на личните API | E2E | PASS; на реален HTTPS origin — не е проверено |
| 17 | Остарял heartbeat → owner вижда проблема | тестове + production профил | PASS |
| 18 | Нов build/restart върху същата PostgreSQL база | production профил | PASS |
| — | `node scripts/validate-render-yaml.mjs` | официална schema | PASS (+ отрицателна проба хваща грешни plan/region) |
| — | `npm run pg:backup` / `pg:restore-check` | PostgreSQL | PASS |
| — | `docker compose -f docker-compose.test.yml up` | — | BLOCKED (няма Docker) |
| — | GitHub Actions | — | не е изпълнен (няма хранилище) |

## K. Backup, cutover и rollback

- SQLite: backup преди миграцията на работната база `backups/demo-2026-10-08T20-22-55-674Z.db` (сверени бройки); миграцията първо е приложена на копие.
- PostgreSQL: `pg:backup` (custom dump + manifest от същия snapshot) → `pg:restore-check` в отделна празна база → PASS; `migrate:verify` на възстановената база — PASS. Restore отказва непразна/същата база.
- Cutover: 9 стъпки в `docs/CUTOVER-AND-ROLLBACK.md` (deploy с изключени gates → readiness → спиране на локалните записи и worker → финален export → импорт + verify → вход със същата парола → push/имейл → gates само в облака → облакът е авторитетен), вкл. правилата при cutover след 08:00 и `notifications:release`.
- Rollback: без автоматично връщане към SQLite snapshot след нови облачни записи (загуба на данни); спиране на записите, backup, ръчно сверено пренасяне или forward fix.
- Ограничения: rehearsal-ът е с копие от 08.10 23:37; финалният export ще е различен. Трайната backup дестинация е само документирана (не е създаден облачен акаунт).

## L. Предстоящи външни стъпки (не е незавършен код)

1. Частно GitHub хранилище и remote; push на `main` (локален commit — виж M).
2. Render: Blueprint от `render.yaml` (платени планове; цената се потвърждава в Render).
3. Canonical HTTPS адрес → `APP_BASE_URL` (onrender адрес или собствен домейн; DNS — само ако решиш).
4. VAPID ключове (генерират се локално), SMTP доставчик и credentials, `SMTP_FROM` (SPF/DKIM), `OWNER_NOTIFY_EMAIL`.
5. Временен IP в allow list на базата за импорта; финален export + импорт + verify.
6. Телефон: „Активирай известията“ на HTTPS адреса (iPhone: от началния екран), реален тест push/имейл.
7. Включване на `SCHEDULER_ENABLED` / `DELIVERIES_ENABLED` само в облачния worker; спиране на локалния за реална работа.
8. Трайна криптирана backup дестинация.

## M. Как да продължим

**Локален production тест (PowerShell)**

```powershell
cd "C:\Users\The King\Desktop\Sites\15. BDS LeadFlow"
$env:Path = "$PWD\.tools\node-v24.21.0-win-x64;$env:Path"      # портативен Node 24 само за тази сесия
npm run pg:local -- start                                       # disposable PostgreSQL на 127.0.0.1:54315
npm run test:pg                                                 # интеграционните тестове върху PostgreSQL
# пробен пренос на ново копие (работната база само се чете):
npm run migrate:export
& .tools\pgsql\bin\psql.exe "postgresql://lf_test:lf_test_local_only@127.0.0.1:54315/postgres" -c "CREATE DATABASE leadflow_rehearsal2"
$env:DATABASE_URL = "postgresql://lf_test:lf_test_local_only@127.0.0.1:54315/leadflow_rehearsal2"; npm run db:deploy; Remove-Item Env:DATABASE_URL
$env:TARGET_DATABASE_URL = "postgresql://lf_test:lf_test_local_only@127.0.0.1:54315/leadflow_rehearsal2"
npm run migrate:dry-run -- --archive "backups\migration\<време>\archive.json.gz"
npm run migrate:import  -- --archive "backups\migration\<време>\archive.json.gz"
npm run migrate:verify  -- --archive "backups\migration\<време>\archive.json.gz"
Remove-Item Env:TARGET_DATABASE_URL
npm run pg:local -- stop
```

Build/E2E в основната папка отказват, докато `npm run dev:all` работи (споделена `.next`) — използвай чисто копие или спри dev сървъра.

**GitHub / Render (бъдеща последователност)**

1. Прегледай локалния commit (`git log --stat`), създай частно хранилище в GitHub, после: `git remote add origin <URL>` и `git push -u origin main`.
2. Изчакай зелен CI (`.github/workflows/ci.yml`).
3. Render → New → Blueprint (`docs/RENDER-SETUP.md` §6), gates остават `false`.
4. Cutover по `docs/CUTOVER-AND-ROLLBACK.md`.

---

**Кратко резюме**

- Кодът е готов за GitHub/Render; PostgreSQL runtime е реално проверен локално (тестове, production команди, пробен пренос на реалните данни — PASS).
- Локалният сайт работи на http://localhost:3015 със същия owner акаунт; първият реален списък остава за пт 09.10.2026 08:00 от локалния worker.
- Остават външни стойности/действия: GitHub хранилище и push, Render ресурси (платени), canonical HTTPS адрес, VAPID ключове, SMTP credentials и owner имейл, регистрация на телефона, финален export/импорт и включване на gates. Push до телефон и реален имейл не са проверени.
