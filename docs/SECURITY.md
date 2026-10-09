# Сигурност — BDS LeadFlow

## Auth

- Един owner (`User.ownerSlot UNIQUE`). Няма регистрация през web и няма default admin/admin. Акаунтът се създава с `npm run owner:create` — интерактивно, паролата е скрита, не минава през аргументи, shell история или логове. Минимум 12 символа, със забранени тривиални думи.
- Хеширане: **Argon2id** (`@node-rs/argon2`, m=19456, t=2, p=1).
- Сесии: 256-bit случаен token в `lf_session` cookie (HttpOnly, SameSite=Lax, Secure винаги в production и при HTTPS `APP_BASE_URL`, изтичане 168 ч.). В DB се пази само `sha256(token)` — няма споделен session secret между процесите. Logout изтрива сесията. „Изход от всички устройства“ (Настройки → Данни) изтрива всички сесии. Смяната на паролата изтрива всички сесии. Сесиите не се пренасят при миграция към PostgreSQL (нов вход със същата парола).
- Не се създава owner/стандартна парола при startup; няма отворена регистрация.
- Смяна на паролата (`owner:create` при съществуващ owner): новият Argon2id хеш, изтриването на **всички** сесии и audit записът (без паролата) са в една DB транзакция. Слаба или несъвпадаща парола не променя нищо. Скриптът не пита за старата парола — достъпът до терминала и до файла на базата е предпоставка (локален single-owner инструмент). Проверено с истинския скрипт в `tests/integration/hardening.test.ts`.
- Login rate limit: 5 неуспешни опита за 15 мин. по потребител и по IP. Съобщението е еднакво при грешен потребител и грешна парола. При несъществуващ потребител също се проверява (dummy) хеш, за да не се издава кой съществува чрез времето за отговор.
- Server-side проверка в **всяка** CRM страница (`requirePageOwner`) и **всеки** API route (`api()` wrapper). Не се разчита на middleware/proxy. T36 проверява 401/redirect.

## CSRF и входни данни

- Всички cookie-auth мутации (POST/PUT) изискват `Origin` равен на `APP_BASE_URL` или на `ALLOWED_ORIGINS`. Собственият Host се допуска само локално (`APP_ENV=local`); в production Host header-ът никога не дава доверие и не се ползва за линкове. При cross-site `Sec-Fetch-Site` се отказва. Без Origin → 403 (T37, production тест).
- IP за login rate limit: само от доверените proxy hops (`TRUSTED_PROXY_HOPS`, Render: 1) — левите стойности в X-Forwarded-For се подават от клиента. Лимитът по потребител е независим.
- Zod валидация на всеки write path. JSON body е ограничен до 3 MB, а импортът до 2 MB / 5000 реда.
- URL полетата приемат само `http/https` без credentials (`safeHttpUrl`). `javascript:`, `data:`, `ftp:` се отказват (T37). Външните линкове са с `rel="noopener noreferrer nofollow"`.
- Текстът (бележки, отзиви) се render-ва като React текст. Няма `dangerouslySetInnerHTML`.
- CSV export: UTF-8 BOM. Стойности, започващи с `= + - @ TAB CR`, получават водещ апостроф (formula injection, T40). Телефоните се пазят като текст.

## Тайни

- Само `NEXT_PUBLIC_VAPID_PUBLIC_KEY` стига до браузъра. `VAPID_PRIVATE_KEY`, `SMTP_PASS` и `GOOGLE_PLACES_API_KEY` се четат само на сървъра. UI показва само configured/missing. T38 сканира заредените отговори и `.next/static/chunks` за стойностите на тайните.
- `.env`, `data/`, `backups/`, `tests/.tmp` са в `.gitignore`. `.env.example` съдържа само placeholders.
- Push endpoints/ключове се пазят в DB и не се връщат към UI (показват се само етикет и статус).
- Публичните `/api/health` (`{ok, service}`) и `/api/ready` (`{ready}` + 200/503) не съдържат CRM данни, env, схема или stack trace. Подробностите за worker/миграции са само за owner.
- Production конфигурацията се валидира при старт (web: `src/instrumentation-node.ts`; worker): без PostgreSQL, без https canonical адрес или в demo режим процесът спира. Съобщенията съдържат имената на променливите, не стойностите. `sslaccept=accept_invalid_certs` е забранено.
- `DATABASE_URL` за миграционните скриптове е само в env (`TARGET_DATABASE_URL`), паролата се маскира в изхода.
- Security headers: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. Няма analytics, пиксели или trackers.
- Локално слуша само на `127.0.0.1`. Production (`node scripts/start-web.mjs`) слуша на `0.0.0.0:$PORT` зад HTTPS на Render.
- Публична разписка от service worker (`POST /api/push/receipt`): изисква Origin и еднократен token от криптирания payload (в DB е sha256); отговорът не издава дали token-ът съществува.

## SSRF (live website audit — изключен по подразбиране)

`src/providers/webAudit.ts`: само http/https на портове 80/443, без credentials, без `localhost`/`.local`/`.internal`. DNS резолюцията изисква всички адреси да са публичен unicast (IPv4, IPv6, IPv4-mapped; блокирани са loopback, private, link-local, 169.254.169.254, CGNAT, ULA). Връзката се прави към **вече проверения IP** чрез pinned `lookup` — това е защитата от DNS rebinding. Всеки redirect (макс. 3) се валидира наново. Има timeout 8 с., лимит 512 KB и не се изпълнява JavaScript. T39 покрива схеми, портове, частни IPv4/IPv6, mapped адреси, относителни redirects и DNS към частен адрес.

## PWA / service worker

`public/sw.js` кешира **само** `/offline.html`, иконите и manifest-а. Навигациите винаги минават през мрежата. `/api/*`, auth и CRM HTML не се кешират. Offline редакции няма. При logout се изтриват непознати кешове. T44 проверява съдържанието на Cache Storage и достъпа след logout. Push payload-ът не съдържа имена или телефони. Кликът винаги води към `/today` (login при нужда).

Push изисква secure context. `localhost` е secure, но HTTP LAN адрес на телефона **не е**. Push към истински телефон: **NOT VERIFIED**.

## DNC и retention

- DNC потиска бизнеса и всичките му силни идентификатори (телефон, домейн, ЕИК, Place ID). Отменя отворените follow-ups. Блокира обаждане, follow-up и маркиране на оферта като изпратена — и в UI, и на backend (T19). Премахването става само с owner действие, причина (5+ символа) и audit. Записът не става „нов“.
- Retention: DNC и минималните идентификатори се пазят, за да работи потискането. Пълното заличаване на идентификаторите **отслабва** бъдещото разпознаване. Това е съзнателен компромис — не обещаваме едновременно нулеви данни и вечна дедупликация. Hash на телефон не е анонимизация.
- Архивирането е основното действие вместо изтриване. Архивирането и повторният импорт не нулират blockers (T08).

## Backup

PostgreSQL: `npm run pg:backup` (pg_dump със споделен snapshot за бройките) и `npm run pg:restore-check` в отделна празна база — виж `docs/CUTOVER-AND-ROLLBACK.md`. Миграционните архиви и dump-овете съдържат CRM данни: `.gitignore` изключва `backups/`, `*.dump`, `archive.json.gz`, `*.xlsx`, `*.csv`, `*.log`.


`npm run backup` използва `VACUUM INTO` — консистентно и при WAL, а не копие на main файла. Backup-ът се възстановява в **отделна временна** база и totals/history/DNC се сравняват (T43). Активната база не се презаписва автоматично. Backups са в `backups/` (gitignored). В real режим backup-ите съдържат лични служебни данни: криптирано съхранение и retention са задача за go-live.

## Достъпност и контраст (WCAG, изчислено)

| Комбинация | Контраст |
| --- | --- |
| #F8FAFC върху #08111F / #101B2D / #121F33 | 18.08 / 16.50 / 15.81 |
| #A8B3C7 върху #08111F / #101B2D / #121F33 | 8.95 / 8.17 / 7.83 |
| #60A5FA (линкове/focus) върху #08111F / #121F33 | 7.44 / 6.51 |
| #08111F текст върху #3B82F6 бутон | 5.14 |
| бял текст върху #3B82F6 | 3.68 — **не** се използва за нормален текст |
| #34D399 / #FBBF24 / #F87171 върху #121F33 | 8.60 / 9.91 / 5.98 (винаги с текст/икона) |
| #22324A разделители върху #08111F | 1.46 — само декоративни разделители |
| #5A6E8C рамки на полета/бутони върху #08111F / #121F33 | 3.64 / 3.19 (≥3:1, WCAG 1.4.11) |

Има видим focus (2px #60A5FA), labels на всички полета (T47 проверява Настройки), Escape и връщане на фокуса в dialog-ите, `prefers-reduced-motion`, tap targets ≥40px и текстови етикети на деветте резултата.

## Известни ограничения

- Rate limit-ът е в DB по IP. Зад reverse proxy трябва да се доверява само на собствения proxy (`x-forwarded-for`).
- Няма 2FA (single-owner локален инструмент).
- `npm audit` (проверено с Node 24.21.0, 08.10.2026): общо 13 — 2 critical (vitest, tinypool), 9 high, 2 moderate. **Production веригата** (`--omit=dev`): 3 high — deepmerge-ts (stack exhaustion при рекурсивни обекти) през `@prisma/config`/`prisma`. Уязвимият диапазон на prisma е 6.13 – 8.1.0-dev, така че **Prisma 7 не го поправя**; npm предлага downgrade до prisma 6.12.0. Останалите (vitest/@vitest/mocker, tinypool, vite, esbuild, braces) са само dev/test tooling. Поправката на vitest е 5.0.3 (major; изисква Node `^22.12 || ^24 || >=26`). Не са правени major upgrade-и/downgrade-и в тази проверка — рискът е приет за локалното демо и е задача за go-live.
- SMTP няма idempotency key. При timeout след приемане е възможен дубликат на fallback имейла (документиран риск, един логически запис в outbox).

## Оценка на npm advisories (08.10.2026)

- **deepmerge-ts 7.1.5 (high, GHSA-ggr8-5vv4-36mx):** stack exhaustion само при сливане на **циклични** обекти. Идва единствено по веригата `prisma` (CLI, devDependency) → `@prisma/config`; `@prisma/client` не зависи от него. Проверено: не е в нито един bundle на Next (`.next/server`, `.next/static` — 0 съвпадения) и не се зарежда от worker-а. Конфигурацията, която се слива, е нашата (без външен вход; JSON не може да съдържа цикли). **Риск: пренебрежим. Не се поправя сега.** Prisma 7 не го решава (уязвим диапазон до 8.1.0-dev). Ако е нужно: npm `overrides` за deepmerge-ts@8 след тест.
- **vitest / @vitest/mocker (critical), tinypool (critical), vite (high), esbuild (moderate), braces (high):** само в тестовите и build инструментите. Изискват атакуващ контрол върху тестовата конфигурация, опциите на workers или достъп до vite/esbuild dev сървър. Такъв сървър не се стартира: Next ползва Turbopack, а vitest работи без UI/browser режим. Не се зареждат от сайта или worker-а. **Риск за локалното демо: нисък.** Поправката (vitest 5) е major и изисква Node ≥22.12 — отложено.

## Избор на env файл (real режим)

`@prisma/client` при зареждане сам чете `.env` (demo). Затова изрично избраният файл (`.env.real` чрез `LEADFLOW_ENV_FILE` / `scripts/with-env.mjs`) **презаписва** стойностите. Иначе real режимът тихо би наследил demo настройки — открито и поправено при `real:init`. `.env.real.example` дефинира всички ключове изрично, а Next не попълва празни стойности от `.env`.

## Git проверка (09.10.2026)

Хранилището няма remote. Проверени са всички файлове, които биха влезли в commit (`git ls-files --others --exclude-standard`, 236): няма `.env`, бази, WAL/SHM, backup-и, миграционни архиви, dump-ове, реалния Excel, логове, trace/video, `.verify` или `node_modules`; няма шаблони на частни ключове/токени; 0 съвпадения с 861 стойности (имена, телефони, адреси) от 216-те реални записа. Screenshots в `docs/screenshots` са от синтетичната e2e база. Телефонните номера в тестовете са синтетични. Git история не е пренаписвана (няма такава).
