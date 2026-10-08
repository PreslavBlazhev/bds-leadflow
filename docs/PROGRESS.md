# PROGRESS — BDS LeadFlow

Последна актуализация: 09.10.2026

## Checkpoints

| # | Етап | Статус |
| --- | --- | --- |
| 1 | Проверка на папката/средата, план, scaffold (Next 16.4, TS 6.0, Tailwind 4.3, Prisma 6.19, Zod 4, Vitest 3.2, Playwright 1.63) | ГОТОВО |
| 2 | Schema/migrations (2), auth (Argon2id + DB сесии), seed, identity/eligibility/DNC инварианти | ГОТОВО |
| 3 | 9 екрана + detail panel + call workflow | ГОТОВО (всички страници връщат 200 в dev) |
| 4 | Scheduler worker, outbox, demo clock, fallback | ГОТОВО |
| 5 | Providers (Demo/CSV/B2B интерфейс/Google Places BLOCKED), import/export, SSRF, restricted guard | ГОТОВО |
| 6 | Тестове: unit 35/35, integration 41/41, E2E 10/10; build OK | ГОТОВО |
| 7 | Документация, 13 screenshots, IMPLEMENTATION-REPORT | ГОТОВО |
| 9 | Практичност: опашки, Обаждания, Днес | ГОТОВО (08.10.2026) |
| 10 | Подготовка за първите реални бизнеси: real база, пилот с Google Places (само place_id), сравнение с историята, ръчен преглед | ПОДГОТВЕНО, не е пускано — чака ключ (08.10.2026) |
| 8 | Финализираща проверка: Node 24.21.0 в чисто копие, engines, T01–T48 покритие, E2E логове, owner:create | ГОТОВО (08.10.2026) |
| 11 | Подготовка за GitHub + Render (web, worker, PostgreSQL): двойна Prisma схема, PG миграции, пренос на данни, worker heartbeat/gates, push разписки, render.yaml, CI | КОДЪТ ГОТОВ, локално проверен с PostgreSQL 18.6; нищо не е публикувано (09.10.2026) — `docs/PRODUCTION-PREP-REPORT.md` |

## Как да продължа при нова сесия

```powershell
cd "C:\Users\The King\Desktop\Sites\15. BDS LeadFlow"
npm run test; npm run test:integration
npm run dev:all   # http://localhost:3015
```

## Известни бележки

- Build/start/check/E2E отказват, докато `npm run dev`/`dev:all` работи (споделена `.next` развали dev сървъра на 08.10 → безкраен refresh; поправено с чиста `.next` + guard).
- `npm run db:migrate` изисква спрени app/worker (иначе SQLite „database is locked“).
- Глобалният Node на машината е v21.5.0 — **извън** engines `^20.19.0 || ^22.13.0 || >=24.0.0`. Проектът е проверен с Node 24.21.0 (изолиран). Препоръка: Node 24 LTS глобално.
- Неизяснен: един E2E exit 1 от първата сесия (логът е изгубен; не се възпроизвежда). Новите пускове пазят логове в `tests/.tmp/e2e-runs/`.

## Текущ статус

Демото работи на http://localhost:3015 (`npm run dev:all`). Реалната база е създадена (`npm run real:init`, извън проекта, без demo записи, новите списъци на пауза). Следваща стъпка: Google Cloud проект + Places API (New) ключ в `.env.real` → `npm run pilot:discover` (план) → `--run --limit=25`. Виж docs/PILOT.md.


## 08.10.2026 — Импорт на реални бизнеси (Excel)

- 216 бизнеса от `biznesi_varna_bez_sait.xlsx` › „Основен списък“ в работната база; 35 прозвънени преди импорта (№1–20, 51–65), 181 допустими.
- Нова настройка „Източник на новите дневни списъци“ = Реални; първи реален списък 09.10.2026 08:00.
- Подробности и проверки: docs/REAL-DATA-IMPORT-REPORT.md.

## 08.10.2026 — Активен списък до приключване и повторни обаждания

- Нов списък само пн–пт, след 08:00 и само ако предишният реален списък е изцяло обработен до 08:00 (устойчиво „обработен“ за всяко участие).
- „Не отговори“ → автоматично повторно обаждане след 2 (или 3) работни дни в 08:00; една активна задача на бизнес.
- Опашки: „Активен списък“ (вкл. от предишни дни) и „За повторно обаждане“. Подробности: docs/ACTIVE-LIST-AND-RETRIES-REPORT.md.

## 09.10.2026 — Подготовка за production (GitHub + Render)

- PostgreSQL: генерирана схема + отделна миграционна история; двата Prisma клиента от `npm ci`; тестовете вървят и върху PostgreSQL (`npm run test:pg`).
- Пробен пренос на копие от работната база в disposable PostgreSQL: PASS (`docs/DATABASE-MIGRATION.md` §4).
- Worker: schema readiness, heartbeat в DB, gates, SIGTERM, backoff. Известия: разписки от service worker, остарели → skipped, `cutover_hold`, NOTIFY_DRY_RUN.
- Работната база получи добавяща миграция `20261009000000_production_prep` (backup преди това: `backups/demo-2026-10-08T20-22-55-674Z.db`).
- Следва: GitHub remote + push, Render Blueprint, cutover по `docs/CUTOVER-AND-ROLLBACK.md`.
