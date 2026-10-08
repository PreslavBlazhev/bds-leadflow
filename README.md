# BDS LeadFlow

Лична single-owner система за Bulgaria Digital Services: всяка сутрин до 25 **нови**, проверени бизнес контакта, обаждания, follow-ups, оферти, клиенти и статистика. Локално работи със SQLite (`http://localhost:3015`). Кодът е подготвен за production на Render (web + Background Worker + PostgreSQL), но **нищо не е публикувано** — виж `docs/PRODUCTION-PREP-REPORT.md`, `docs/RENDER-SETUP.md` и `docs/CUTOVER-AND-ROLLBACK.md`.

## Quick start (Windows PowerShell)

```powershell
cd "C:\Users\The King\Desktop\Sites\15. BDS LeadFlow"
npm install            # първи път; после: npm ci (от фиксирания package-lock.json)
npm run setup:demo     # .env (само ако липсва) + миграции + idempotent seed + днешния списък
npm run owner:create   # интерактивно: потребител + парола (мин. 12 символа); паролата не се показва
npm run dev:all        # app + worker в един терминал → http://localhost:3015
```

Отвори **http://localhost:3015** и влез с акаунта от `owner:create`.

Два терминала вместо `dev:all`:

```powershell
npm run dev          # терминал 1: web на http://localhost:3015 (слуша само на 127.0.0.1)
npm run worker:dev   # терминал 2: scheduler + outbox worker
```

## Изисквания

- **Node.js 24 LTS** — фиксирана версия `24.21.0` в `.node-version` (Render я чете), engines `>=24.21.0 <25`. Проверено с портативен Node 24.21.0 в чисто копие (`npm ci`, проверки, тестове върху SQLite и PostgreSQL, build, E2E). Глобалният Node на тази машина е v21.5.0 (извън engines; npm показва предупреждение). Инсталирай Node 24 LTS.
- npm 10, Google Chrome (за E2E: Playwright `channel: "chrome"`, без изтегляне на браузъри).
- Без Redis. PostgreSQL само за production и за тестовете `test:pg` (локален disposable сървър: `npm run pg:local -- start`, без Docker; или `docker-compose.test.yml`).

## Режими и бази

| Режим | `.env` | База | Какво става |
| --- | --- | --- | --- |
| demo (по подразбиране) | `APP_MODE=demo` | `data/demo.db` | Синтетични „ДЕМО …“ бизнеси, симулирани известия, demo контроли |
| real | `APP_MODE=real` | `data/real.db` (друг файл!) | Без seed; demo контролите са забранени на backend; доставки само с конфигурация |

Fail-closed: при създаване базата записва режима си (`SystemMeta`). Несъвпадение с `APP_MODE` спира приложението. Demo и real не могат да ползват един и същ файл.

## Всички команди

| Команда | Какво прави |
| --- | --- |
| `npm run setup:demo` | Създава `.env` само ако липсва, после миграции, seed и днешния списък. Нищо не презаписва |
| `npm run owner:create` | Създава owner или сменя паролата му. Потребителското име е `owner` (входът не е с имейл). Новият хеш, обезсилването на всички сесии и одитът стават в една транзакция |
| `npm run dev` / `npm run worker:dev` / `npm run dev:all` | Web / worker / двете заедно (Ctrl+C спира) |
| `npm run db:migrate` | `prisma migrate deploy` + маркер на режима. **Спри app/worker преди това** (иначе SQLite „database is locked“) |
| `npm run db:seed` | Idempotent demo seed (отказва в real) |
| `npm run db:reset-demo` | Изтрива **само** demo базата след въвеждане на `RESET DEMO`. Отказва при real |
| `npm run typecheck` / `lint` / `test` / `test:integration` | TS strict / ESLint / unit / integration (временни бази) |
| `npm run test:e2e` | `next build` + Playwright: отделна `data/e2e-test.db`, порт 3016, desktop и mobile. Всеки пуск оставя `tests/.tmp/e2e-runs/<време>/` с console.log, summary.json, results.json, html/ и при провал trace/screenshot/video |
| `npm run check` | typecheck + lint + unit + integration + build (E2E е отделно). Build/start/E2E отказват, докато `npm run dev` работи (споделена `.next`) |
| `npm run jobs:daily:dry-run` | Какво БИ избрал дневният job — без записи в DB и без доставки (`-- --date=YYYY-MM-DD`) |
| `npm run demo:next-day` | Само в demo: премества demo часовника с +1 ден и публикува списък. Без реални доставки |
| `npm run backup` | Консистентен backup (`VACUUM INTO`) в `backups/` + автоматична проверка чрез възстановяване във временна база |
| `npm run build` / `npm run start` / `npm run worker:start` | Production-like локален тест (start на 127.0.0.1:3015) |
| `npm run start:web` | Production start на web (Render): `next start` на 0.0.0.0:$PORT. Конфигурацията се проверява при старт |
| `npm run db:generate` | Генерира двата Prisma клиента (SQLite и PostgreSQL); изпълнява се и от `npm ci` |
| `npm run db:pg:schema` / `db:pg:schema:check` | Генерира / проверява `prisma/postgresql/schema.prisma` от `prisma/schema.prisma` |
| `npm run db:deploy` / `db:status` | PostgreSQL миграции (`migrate deploy`; Render preDeploy) / статус. Никога dev/reset |
| `npm run pg:local -- start|stop|status|destroy` | Локален disposable PostgreSQL 18 на 127.0.0.1:54315 (портативни файлове в `.tools/`) |
| `npm run test:pg` | Интеграционните тестове върху истински PostgreSQL (`LF_TEST_PG_URL`, по подразбиране pg:local) |
| `npm run migrate:export` / `migrate:dry-run` / `migrate:import` / `migrate:verify` | Пренос SQLite → PostgreSQL — виж `docs/DATABASE-MIGRATION.md` |
| `npm run pg:backup` / `pg:restore-check` | PostgreSQL backup (pg_dump) и проверка чрез restore в отделна база |
| `npm run notifications:release` | Cutover: задържаните пренесени известия — само за днес обратно в опашката, остарелите → skipped |

## Важно за scheduler-а

Worker-ът работи **само докато процесът е пуснат**. Изключен компютър означава, че няма изпълнение в 08:00. При по-късно стартиране се публикува само днешният списък, маркиран като „закъснял“, а не пропуснатите дни. Статусът се вижда в горния ред („Worker работи / не работи“) и в Настройки → Health.

## Troubleshooting

- **Сайтът се презарежда безкрайно / не може да се пише** (в конзолата на браузъра: `HMR hash mismatch`) — спри `npm run dev:all`, изтрий или премести папката `.next` (само кеш) и стартирай отново. Превенция: `npm run build`, `start`, `check` и `test:e2e` вече **отказват**, докато `next dev` на тази папка работи — първо спри dev сървъра.

- **„database is locked“ при `db:migrate`** — спри `npm run dev` / worker и опитай отново.
- **„Базата е създадена за режим …“** — `APP_MODE` не съвпада с файла в `DATABASE_URL`. Ползвай отделни файлове.
- **Порт 3015 е зает** — смени `-p` в скриптовете `dev` и `start`, и `APP_BASE_URL` в `.env`. Не спирай чужди процеси.
- **Push на телефон** — нужен е HTTPS. HTTP LAN адрес не поддържа push. Виж `docs/SECURITY.md`.
- **Забравена парола** — `npm run owner:create` (сменя паролата).
- **Ръчно възстановяване от backup** — спри app/worker, копирай текущата база настрани, после замени `data/<mode>.db` с backup файла. Изтрий `-wal`/`-shm` файловете на старата база. Първо провери backup-а с `npm run backup` (той прави restore тест).

## Документация

`docs/PRODUCTION-PREP-REPORT.md` (production подготовка, A–M), `RENDER-SETUP.md`, `DATABASE-MIGRATION.md`, `CUTOVER-AND-ROLLBACK.md`, `NOTIFICATIONS-SETUP.md`, `docs/IMPLEMENTATION-REPORT.md`, `ARCHITECTURE.md`, `REQUIREMENTS.md`, `DEMO-GUIDE.md`, `DATA-SOURCES.md`, `GO-LIVE-CHECKLIST.md`, `TEST-REPORT.md`, `SECURITY.md`, `PROGRESS.md`, `screenshots/`.
