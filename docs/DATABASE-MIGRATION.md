# Бази данни: SQLite (локално) и PostgreSQL (production)

Последна проверка: 09.10.2026. Командите са за PowerShell в `C:\Users\The King\Desktop\Sites\15. BDS LeadFlow`.

## 1. Как работят двете бази

| | SQLite | PostgreSQL |
| --- | --- | --- |
| Къде | локалната система (`data/demo.db`, `%LOCALAPPDATA%\BDS-LeadFlow\real.db`) | Render PostgreSQL (production), локален disposable сървър за тестове |
| Схема | `prisma/schema.prisma` — **единственият източник на моделите** | `prisma/postgresql/schema.prisma` — **генерира се** от SQLite схемата (`npm run db:pg:schema`) |
| Миграции | `prisma/migrations/` (6 миграции, историята не е пипана) | `prisma/postgresql/migrations/` — **отделна** история (`20261009000000_init` + следващи) |
| Prisma клиент | `@prisma/client` (стандартният изход) | `node_modules/.prisma-pg/client` |
| Избор | DATABASE_URL започва с `file:` | DATABASE_URL започва с `postgresql://` |

- Един набор бизнес услуги (`src/domain/*`) работи с двата клиента: моделите са байт по байт еднакви, затова TypeScript API-то е едно. Provider-ът се избира от схемата на `DATABASE_URL` (`src/lib/prismaClients.ts`), валидирана в `src/lib/env.ts` — не от env стойност в статичен schema файл и без ръчна смяна преди build.
- `npm ci` (postinstall) и `npm run db:generate` генерират и двата клиента. Generate не се свързва с база.
- `npm run db:pg:schema:check` (и CI) отказва, ако PostgreSQL схемата се е разминала с източника.
- Production (`APP_ENV=production`) приема само PostgreSQL; SQLite URL спира процеса при старт, вместо да създаде празна база.

### Нова промяна в схемата (за бъдеща разработка)

1. Промени `prisma/schema.prisma`.
2. SQLite миграция: `npx prisma migrate dev --create-only --name <име>` върху **тестова** база (никога `data/demo.db`/real), прегледай SQL-а, после `npm run db:migrate` за локалните бази (спри app/worker; backup преди това).
3. `npm run db:pg:schema`.
4. PostgreSQL миграция в нова папка `prisma/postgresql/migrations/<timestamp>_<име>/migration.sql`, генерирана с `npx prisma migrate diff --from-migrations prisma/postgresql/migrations --to-schema-datamodel prisma/postgresql/schema.prisma --shadow-database-url <disposable PG> --script`, плюс ръчните ограничения (частични индекси, CHECK), ако са нужни.
5. `npm run test` + `test:integration` + `test:pg`. На Render миграцията се прилага от preDeploy (`npm run db:deploy`).
`scripts/prisma-pg.mjs` отказва `migrate dev/reset` и `db push` за PostgreSQL.

## 2. Какво от SQLite е проверено и как е пренесено

| Тема | SQLite | PostgreSQL | Проверка |
| --- | --- | --- | --- |
| Дати | DATETIME (UTC, ms) | `TIMESTAMP(3)` (UTC, ms) | Каноничното сравнение е ISO UTC с милисекунди; всички моменти в пробния пренос съвпадат |
| Местна дата на списък | `localDate` TEXT `YYYY-MM-DD` | TEXT + CHECK формат | не зависи от timezone на сървъра |
| Пари | INTEGER евроцентове | INTEGER | суми по оферти/клиенти/плащания съвпадат |
| Float | REAL (рейтинг, увереност) | DOUBLE PRECISION | IEEE754 — същите стойности |
| Decimal / BigInt / Json / Bytes | не се ползват | — | каноничната функция отказва непознат тип |
| JSON | TEXT, валидиран със Zod | TEXT | настройките (`AppSettings.data`) — същият JSON низ |
| Enum-и | TEXT + Zod | TEXT + **CHECK** (статуси, канали, резултати) | невалидна стойност спира импорта целия |
| Autoincrement | няма (cuid текстови ID) | 0 sequences | броячът за `L-000…` е таблица `Counter` и се пренася като данни |
| Nullable unique | `Activity.idempotencyKey`, `Client.offerId`… | същите; NULL не се сравнява | архивната проверка пропуска NULL в unique, както базите |
| Частични индекси | `FollowUp(activityId) WHERE kind='RETRY'` | същият индекс | едно повторно обаждане на опит |
| Търсене | `contains` (LIKE) | `contains` (LIKE, чувствително) | кирилицата в SQLite LIKE също е чувствителна към регистъра → еднакво; `normalizedName` е нормализиран в кода |
| Collation / подредба | BINARY | default на базата (Render: обикновено en_US.UTF-8) | бизнес подредбата (кандидати, позиции) е в кода, не в SQL; само азбучните UI списъци могат да се подредят различно |
| Транзакции и lock-ове | един writer + busy_timeout + retry | READ COMMITTED + `pg_advisory_xact_lock` за публикуване, `SELECT … FOR UPDATE` за бизнеса при запис на резултат, retry при 40001/40P01/P2034 | 2 worker процеса + web: един списък (тест) |
| Връзки | `connection_limit=1` | пул на процес: web 5, worker 3 | Render 0.1c-256mb: до 100 връзки |

## 3. Пренос SQLite → PostgreSQL

Скриптове (`scripts/migrate-data.ts`, логика в `src/domain/migration.ts`):

```powershell
npm run migrate:export                                   # 1. консистентен snapshot + архив
$env:TARGET_DATABASE_URL = "postgresql://…"              # целевата база (САМО в env, не в аргументи)
npm run migrate:dry-run -- --archive <папка>\archive.json.gz   # 2. проверка, без запис
npm run migrate:import  -- --archive <папка>\archive.json.gz   # 3. импорт в една транзакция
npm run migrate:verify  -- --archive <папка>\archive.json.gz   # 4. независимо сверяване + report.md
Remove-Item Env:TARGET_DATABASE_URL
```

1. **Export** — `VACUUM INTO` (транзакционно копие, безопасно при WAL и работещо приложение) → `backups/migration/<време>/snapshot.db`; архивът се чете от копието, не от живата база. `archive.json.gz` съдържа: версия на формата, момент на snapshot-а, миграциите на източника, всяка таблица с полета/типове/nullable, бройка и SHA-256 върху каноничните редове. `manifest.json` съдържа само бройки.
2. **Dry-run** — gzip/JSON цялост, версия, точно съвпадение на миграциите с кода, полетата спрямо текущата схема, типове, първични ключове, unique, всички FK връзки, стойностите от CHECK ограниченията, Zod на настройките, точно един owner, `demoDayOffset = 0`. Показва трансформациите.
3. **Import** — само към PostgreSQL; изисква готова схема (`db:deploy`) и **празна** целева база. Един и същ архив повторно → 0 промени. Друг архив върху пренесена база → отказ преди промяна. Всичко е в **една транзакция** — повреден архив, осиротяла връзка или DB ограничение по средата не оставят нито един ред (тествано).
4. **Verify** — чете целевата база наново: всяка таблица ред по ред в каноничен вид (с документираните трансформации), всички FK със SQL, броят sequences, и бизнес проверки със същия код върху snapshot-а и PostgreSQL (виж §4). Пише `report.md` до архива — без контакти, без хешове.

**Запазва се:** всички ID-та (няма mapping), връзки, моменти, местните дати на списъците, участията и техният `processedAt/processedOutcome`, follow-ups, оферти, клиенти, плащания, DNC/телефонни блокировки, идентификатори за дедупликация, импорт batch-ове и произход (`sourceName/Sheet/RowNo`, `sourceCheckedOn` = 2026-09-15 — не се обновява), `priorContact` историята, одит, настройките (свежест 30 дни — каквото е записано), JobRun ключовете (предпазват от повторно публикуване), owner потребител и паролният hash.

**Трансформации (документирани, показват се в dry-run):**

| Таблица | Какво | Защо |
| --- | --- | --- |
| SystemMeta | `mode: demo → real`; `migratedFromArchive`, `migratedAt` | production е real; демо записите остават `isDemo=true` и не влизат в реалните опашки (настройката „Източник“ вече е REAL) |
| Session | не се пренася | нов вход в production със същата парола |
| WorkerHeartbeat | не се пренася | оперативно състояние на локалните процеси |
| NotificationOutbox | неизпратените (`queued`, `retry_scheduled`, `processing`) → `cutover_hold` | никога автоматично изпращане от пренесени задачи; `npm run notifications:release` |
| PushSubscription | пазят се като история, `revokedAt` = момента на импорта | обвързани са с локалния origin/VAPID ключ; телефонът се регистрира наново |
| AuditLog | +1 запис `migration.import` | одит на преноса |

## 4. Пробен пренос, 08–09.10.2026 (реално проверено локално)

- Източник: копие (`VACUUM INTO`) на работната `data/demo.db`. Snapshot **2026-10-08T20:37:42.575Z** (23:37 местно). Работната база само е прочетена.
- Цел: disposable PostgreSQL 18.6 (портативен, 127.0.0.1:54315), база `leadflow_rehearsal`, ICU `en-US` collation.
- Архив: 31 таблици, 4082 реда, 209 KB, `backups/migration/2026-10-08T20-37-42-543Z/` (локално, извън Git).
- Dry-run OK; импорт **4082 реда за 1,3 s**; verify **PASS**: 31/31 таблици ред по ред, 23 FK проверки — 0 осиротели, 0 sequences.
- Бизнес проверки (еднакви в двете бази): 620 бизнеса; **216 реални**; 404 демо (история); **35 прозвънени преди импорта** (потвърдено от собственика, без дата/резултат); **181 още незвънени**; 216 с дата на проверка 2026-09-15; 5 списъка (04–08.10, по 25 демо); 45 обработени участия; реален активен списък — няма; **181 допустими нови кандидати** с идентичен ред; 7 отворени повторни обаждания; 3 активни DNC; 1 блокиран телефон; 1648 идентификатора; суми на оферти/клиенти/плащания; брояч L-000620; настройки (свежест 30, пн–пт, повторно след 2 работни дни, източник REAL) и owner hash — идентични. 0 сесии в целта. 0 задържани известия (всички локални са `simulated`/`skipped`).
- Повторен импорт: „вече пренесен — 0 промени“; verify отново PASS.
- PostgreSQL backup → restore в трета база → бройките съвпадат с manifest-а → verify на възстановената база спрямо архива: PASS.

Финалният export за live ще се направи непосредствено преди cutover (виж `docs/CUTOVER-AND-ROLLBACK.md`) — междувременно има обаждания и нови списъци.

## 5. Тестови бази

- Интеграционните тестове: SQLite копие от мигриран template (`npm run test:integration`) или PostgreSQL база за всеки тест от мигриран template (`npm run test:pg`, `LF_TEST_PG_URL`). Отказват не-localhost сървър (освен `LF_TEST_PG_ALLOW_REMOTE=1` в CI), тестовите бази се казват `lf_*_test` и се изтриват след теста.
- E2E: само `data/e2e-test.db`.
- Импортът отказва целева база, равна на `DATABASE_URL` на локалното приложение.
