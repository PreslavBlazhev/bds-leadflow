# Requirements checklist

Статуси: **WORKING LOCAL** (реална логика + съхранение, тествано локално) · **DEMO / SIMULATED** · **IMPLEMENTED, NOT LIVE-VERIFIED** · **BLOCKED** · **PARTIAL** · **MISSING**.

| # | Изискване (раздел от заданието) | Код | Тест | Статус |
| --- | --- | --- | --- | --- |
| 01 | Само целевата папка, без deploy/външни съобщения | — | — | изпълнено |
| 02 | До 25 нови/ден, честен недостиг, без дубликати | `domain/batch.ts`, `eligibility.ts` | T01–T05, T12 | WORKING LOCAL (кандидатите са DEMO) |
| 02 | Известия само push + имейл | `domain/notifications.ts`, `providers/delivery.ts` | T29–T34 | push/email: IMPLEMENTED, NOT LIVE-VERIFIED; в demo — SIMULATED |
| 03 | Разграничени статуси във всички екрани | `components/ui.tsx` StateBadge, Настройки → Източници | E2E screenshots | WORKING LOCAL |
| 03 | Отделни demo/real бази, fail-closed | `lib/env.ts`, `lib/db.ts` assertDbMode | demo-data „fail-closed“ | WORKING LOCAL |
| 04 | Редактируеми defaults (25, 08:00, 07:00, дни, резерв 100, Варна 15/Плевен 5/други 5, категории, EUR в центове, dd.MM.yyyy, 24ч) | `domain/settings.ts`, `SettingsForm.tsx` | T14, T26, E2E T48 | WORKING LOCAL |
| 04 | „Останали от предишни дни“ отделно; пауза при backlog | `batch.ts backlogItems`, Днес | T03 | WORKING LOCAL |
| 05 | Next App Router, TS strict, Tailwind, Prisma+SQLite, Zod, Vitest, Playwright, lockfile | package.json | typecheck/lint | WORKING LOCAL — engines `^20.19.0 || ^22.13.0 || >=24.0.0`; проверено с Node 24.21.0 в чисто копие (глобалният Node 21.5 е извън engines) |
| 05 | Migrations, seed, env validation, health | prisma/migrations, scripts, `/api/health` | T36 | WORKING LOCAL |
| 06 | BDS цветове като tokens, практичен UI, desktop sidebar/mobile bottom nav | `globals.css`, `(app)/layout.tsx` | T46 | WORKING LOCAL |
| 06 | Достъпност | Dialog, labels, focus | T47 | WORKING LOCAL (без пълен ръчен a11y одит) |
| 7.1 | Днес (броячи, секции, поредност, история по дати, idempotent, demo панел) | `(app)/today` | T04, T13, E2E | WORKING LOCAL |
| 7.2 | База: табове, server-side търсене/pagination, филтри, редакция, ръчно добавяне, архив, import/export, detail panel, запазени филтри (локално) | `(app)/leads` | E2E, T08, T40 | WORKING LOCAL |
| 7.3 | Обаждания: един контакт, 9 резултата, запази и следващ, предишен, пропусни, прогрес, dial intent, guard при незаписано | `(app)/calls`, `CallSession`, `UnsavedGuard` | T15–T18, E2E | WORKING LOCAL; tel: — NOT LIVE-VERIFIED |
| 7.4 | Pipeline с dropdown, история, стойности; stage ≠ outcome | `(app)/pipeline`, `crm.moveStage` | T21 | WORKING LOCAL (drag-and-drop не е реализиран — по избор) |
| 7.5 | Последващи: просрочени/днес/предстоящи, изглед по дни, приключване, пренасрочване | `(app)/follow-ups` | E2E | WORKING LOCAL |
| 7.6 | Оферти: CRUD, статуси, ръчно „изпратена“, копиране/печат, прогноза ≠ приета ≠ получено | `(app)/offers` | T20, T22, E2E | WORKING LOCAL (без PDF — не се изисква) |
| 7.7 | Клиенти: сделка, суми, статус, ръчни плащания | `(app)/clients` | T22, E2E | WORKING LOCAL |
| 7.8 | Статистика от DB с дефиниции и малка извадка | `domain/stats.ts` | T23, T48 | WORKING LOCAL |
| 7.9 | Настройки, health, устройства, providers (configured/missing), jobs/outbox | `(app)/settings` | E2E | WORKING LOCAL |
| 08 | 18 групи полета в детайла с „Неизвестно/Непроверено“ | `components/LeadDetail.tsx` | E2E screenshot | WORKING LOCAL |
| 09 | 9 резултата + матрица + callConnected + activity типове | `domain/outcomes.ts` | T15–T22 | WORKING LOCAL |
| 09 | DNC в UI и backend, отмяна, премахване с audit | `outcomes.applyDnc/liftDnc` | T19 | WORKING LOCAL |
| 10 | Никакви повторни нови: identity (телефони, домейни/PSL, platform домейни, EIK, Place ID, име+град), review, merge, DB constraints, idempotency | `identity.ts`, `ingest.ts`, `crm.mergeBusinesses`, schema | T01–T14 | WORKING LOCAL |
| 11 | Обясним score, взаимно изключващи се правила, clamp, версия, tie-break | `scoring.ts`, `eligibility.eligiblePool` | T24 | WORKING LOCAL |
| 12 | DemoProvider | `providers/candidates.ts` | T42 | DEMO / SIMULATED |
| 12 | CSV импорт с provenance | `domain/csv.ts` | T08, T11, T40 | WORKING LOCAL |
| 12 | B2B интерфейс | `B2BProvider` | — | BLOCKED (няма доставчик) |
| 12 | Google Places read-through + licensing gate | `fetchPlaceDisplay`, `stripRestricted` | T41 | BLOCKED (ключ/условия/e2e) |
| 13 | Website audit (ограничен, SSRF-safe), шаблонни предложения, без AI | `providers/webAudit.ts`, `domain/pitch.ts` | T39 | audit: IMPLEMENTED, NOT LIVE-VERIFIED (изключен); AI: BLOCKED/не е включен |
| 14 | Worker, jobs с lease/retry, DST, catch-up само днес, outbox в същата транзакция | `domain/scheduler.ts`, `worker/` | T25–T28 | WORKING LOCAL (само докато процесът работи) |
| 14 | „Прегледай утре“ без reservation; next-day demo-only | `previewSelection`, `domain/demo.ts` | T35 | WORKING LOCAL |
| 15 | PWA manifest/икони/SW, VAPID adapter, permission по бутон, устройства, без PII в payload, без кеш на CRM | `public/sw.js`, `PushManager.tsx` | T44 | IMPLEMENTED, NOT LIVE-VERIFIED (телефон: NOT VERIFIED) |
| 15 | Един SMTP адаптер, само до owner | `createSmtpTransport` | T29–T33 (mock) | BLOCKED (няма SMTP/адрес) |
| 15 | Fallback правила, outbox статуси, dedupe | `notifications.ts` | T29–T33 | WORKING LOCAL (с mock транспорти) |
| 16 | Нормализирана схема с всички модели | `prisma/schema.prisma` | — | WORKING LOCAL |
| 17 | Сигурност (auth, CSRF, тайни, headers, loopback, backup) | `lib/auth.ts`, `lib/server.ts` | T36–T38, T43, T44 | WORKING LOCAL |
| 18 | CSV import/export (mapping, preview, повторен импорт, BOM, formula injection) | `domain/csv.ts`, `ImportWizard` | T08, T11, T40 | WORKING LOCAL (.xlsx — backlog) |
| 19 | ~400 seed, ≥200 допустими, всички 9 outcomes, fixtures, idempotent, reset с потвърждение | `domain/seed.ts`, `scripts/reset-demo.ts` | T42 | DEMO / SIMULATED |
| 20 | npm команди | package.json | виж TEST-REPORT | WORKING LOCAL — `npm ci` + всички команди проверени в чисто копие с Node 24.21.0; `test:e2e` пази логове/trace |
| 21 | Тестове T01–T48 | tests/ | TEST-REPORT §3 | 44 PASS · 4 PARTIAL · 0 MISSING |
| 22 | Документация + screenshots | docs/ | — | изпълнено |
