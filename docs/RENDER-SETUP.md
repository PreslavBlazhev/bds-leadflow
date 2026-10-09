# Render: настройка (бъдеща стъпка — нищо не е създадено)

Статус към 09.10.2026: `render.yaml` е **локално валидиран** срещу официалната JSON schema (`https://render.com/schema/render.yaml.json`, изтеглена на 08.10.2026) с `node scripts/validate-render-yaml.mjs`. Не е създаден нито един Render ресурс и няма deploy; кодът е в https://github.com/PreslavBlazhev/bds-leadflow (CI зелен). Локалната schema проверка не доказва, че услугите ще стартират в Render.

## 1. Архитектура (render.yaml)

| Ресурс | Тип / план | Команди | Бележки |
| --- | --- | --- | --- |
| `bds-leadflow-web` | web, node, `0.5c-512mb`, frankfurt | build `npm ci --include=dev && npm run build`; preDeploy `npm run db:deploy`; start `exec node scripts/start-web.mjs` (без npm, с exec — SIGTERM трябва да стигне до процеса) | health `/api/health`; `next start` на `0.0.0.0:$PORT`; graceful shutdown 30 s |
| `bds-leadflow-worker` | Background Worker, node, `0.5c-512mb`, frankfurt | build `npm ci --include=dev`; start `exec node --import tsx src/worker/index.ts` (без npm, с exec; SIGTERM тест в CI на Linux) | един постоянен процес; SIGTERM → изчаква tick-а, освобождава lease-овете; 60 s |
| `bds-leadflow-db` | PostgreSQL 18, `0.1c-256mb`, 5 GB, frankfurt | — | `ipAllowList: []` (само вътрешни връзки); платена → PITR и logical exports от Render |
| env група `leadflow-shared` | — | — | само фиксирани стойности: APP_ENV, APP_MODE, DELIVERIES_ENABLED, NOTIFY_DRY_RUN, WORKER_STALE_SECONDS — **една** стойност за двете услуги. Без `sync: false` (виж §3) |

- Плановете са от текущия enum на Blueprint schema (новите `0.5c-512mb`/`0.1c-256mb`; старото `starter` още се приема, но документацията ползва новите ID). Цените се проверяват в Render при създаването — не са потвърдени тук.
- Node: `.node-version` = `24.21.0` (Render: `NODE_VERSION` > `.node-version` > `.nvmrc` > engines). Не задавай `NODE_VERSION`, за да няма две места.
- `--include=dev`: ако build средата е с `NODE_ENV=production`, `npm ci` иначе пропуска dev зависимостите, а `next build` (TypeScript, Tailwind) и `tsx` за worker-а са нужни. Флагът прави резултата еднакъв независимо от това.
- Build: без DB заявки, без SMTP/Google ключове (проверено: build без `DATABASE_URL` и без `.env`). Всички CRM страници са dynamic (`ƒ`); статични са само `/` (пренасочване) и 404.
- `preDeployCommand` (само платени услуги) пуска **само** `prisma migrate deploy` за PostgreSQL. Никога `migrate dev/reset`, никога импорт на CRM данни при deploy.

## 2. База и SSL

- Web и worker получават **вътрешния** `connectionString` (`fromDatabase`) — същата region (frankfurt), частна мрежа. Render: вътрешните връзки поддържат TLS по избор със self-signed сертификати и **не** поддържат `verify-ca/verify-full`; затова вътрешният URL се ползва както е даден, без `sslaccept=accept_invalid_certs` (кодът го забранява).
- Външен адрес (само за еднократния импорт при cutover от твоя компютър) изисква `?sslmode=require` (Render отказва `sslmode=disable`); `src/lib/env.ts` отказва външен адрес без него в production. Временно добави своя IP в `ipAllowList` от Dashboard и го махни след импорта.
- Без PgBouncer (`connectionPoolString` не се ползва): пулът на Prisma е малък (web 5, worker 3), а advisory lock-ът е transaction-scoped.

## 3. Env променливи и тайни

Пълен списък с тип, secret/public и обхват: `.env.production.example`.

- Тайните и стойностите, известни едва при създаването, са `sync: false` → Render ги пита **при първото създаване** на Blueprint-а; после се сменят от Dashboard на съответната услуга. Стойностите не са в Git, логове, отчети или чат.
- **`sync: false` е само на ниво услуга.** Render игнорира `sync: false` в `envVarGroups` (стойността никога не се пита), затова групата `leadflow-shared` съдържа само фиксирани `value`. `node scripts/validate-render-yaml.mjs` (и CI) отказва `sync`, `fromDatabase`, `fromService`, `fromGroup` и `generateValue` в групата, ключ, който е едновременно в групата и в услуга, и `APP_BASE_URL`/`NEXT_PUBLIC_VAPID_PUBLIC_KEY` без `sync: false` в **двете** услуги; при всяко пускане прави и самопроверка, че `sync: false` в група наистина се отказва.
- **`APP_BASE_URL` и `NEXT_PUBLIC_VAPID_PUBLIC_KEY` са декларирани поотделно в web и в worker.** При създаването въведи **ЕДНАКЪВ** `APP_BASE_URL` в двете услуги и **ЕДНАКЪВ** публичен VAPID ключ в двете услуги (или остави ключа празен и в двете). При всяка следваща смяна — смени го и в двете (Dashboard → услугата → Environment). Разминаване: различен APP_BASE_URL → грешни линкове в имейла; различен публичен ключ → абонаментите на телефона не съвпадат с ключа, с който worker-ът изпраща.
- Частният VAPID ключ и SMTP са **само** в worker-а. **Не** използвай `generateValue` за общ secret — всяка услуга получава различна генерирана стойност.

### Какво е нужно за първи старт и какво — по-късно

Първи старт = `SCHEDULER_ENABLED=false`, `DELIVERIES_ENABLED=false` (така е в `render.yaml`). Проверено с тест (`tests/integration/production.test.ts`, „първи старт на Render“): фиксираните стойности от `render.yaml` + `APP_BASE_URL` стартират, а празните стойности за известията не пречат.

| Стойност | Услуга | Първи старт | Бележка |
| --- | --- | --- | --- |
| `DATABASE_URL` | web, worker | задава се автоматично (`fromDatabase`) | вътрешният URL |
| APP_ENV, APP_MODE, DELIVERIES_ENABLED, NOTIFY_DRY_RUN, WORKER_STALE_SECONDS (група); SCHEDULER_ENABLED, WORKER_TICK_SECONDS (worker); TRUSTED_PROXY_HOPS, SESSION_TTL_HOURS, ALLOW_REAL_TEST_DELIVERY (web) | — | фиксирани в `render.yaml` | нищо не се въвежда |
| `APP_BASE_URL` | web **и** worker — еднакъв | **задължителен** | без него (или без https) и двата процеса отказват да стартират. Ако адресът още не е известен: `https://bds-leadflow-web.onrender.com`; ако Render даде друг адрес, смени го в двете услуги |
| `ALLOWED_ORIGINS` | web | празно | само при собствен домейн + onrender адрес |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | web **и** worker — еднакъв | празно | при настройването на известията |
| `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | worker | празно | при настройването на известията |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `OWNER_NOTIFY_EMAIL` | worker | празно | при настройването на резервния имейл |

Ако формата на Render не позволи празна стойност, остави полето както Render допуска и добави стойността по-късно от Dashboard — при `DELIVERIES_ENABLED=false` не се ползва. Пример за всичко: `.env.production.example`.
- Сесиите нямат споделен secret: случаен token в HttpOnly cookie, в базата само sha256. Затова няма SESSION_SECRET.
- `APP_BASE_URL` = canonical HTTPS origin (напр. `https://bds-leadflow-web.onrender.com` или собствен домейн). Разрешените Origin са само той + `ALLOWED_ORIGINS`; Host header не се ползва в production.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` се чете на сървъра при заявка (не е вграден в bundle-а), но е публичен по предназначение. Никакви други `NEXT_PUBLIC_` стойности.

## 4. Gates и readiness

| Gate | Шаблон | Кога се включва |
| --- | --- | --- |
| `SCHEDULER_ENABLED` (worker) | `false` | след проверен cutover — само в облачния worker (`docs/CUTOVER-AND-ROLLBACK.md` стъпка 8) |
| `DELIVERIES_ENABLED` (група) | `false` | след регистриран телефон и настроен имейл |
| `NOTIFY_DRY_RUN` | `false` | `true` за проба на целия път без изпращане |
| `ALLOW_REAL_TEST_DELIVERY` (web) | `false` | за кратко, за един реален тест от Настройки |

- `/api/health` (публичен) — процесът отговаря и базата е достъпна → Render health check.
- `/api/ready` (публичен) — `{ready:true}` 200 само ако приложените миграции съвпадат **точно** с кода и базата е инициализирана; иначе 503. Подробностите са само за owner (Настройки → Health).
- Worker-ът не обработва нищо при липсваща/непозната миграция (`waiting_schema`) или неинициализирана база (`waiting_data`) — вижда се в Health.

## 5. Deploy и версии web/worker

- `autoDeployTrigger: checksPass` — deploy на `main` след успешен GitHub Actions (`.github/workflows/ci.yml`). При промяна на кода GitHub/Render обновяват програмата; обажданията и новите списъци променят само базата. Няма ежедневни commit-и/push-ове с контакти.
- Ред при промяна на схемата: web preDeploy прилага миграцията → новият web и новият worker стават готови. Ако worker-ът се обнови пръв, той чака (`waiting_schema`); старият worker, видял непозната миграция, спира обработката до замяната си. Миграциите трябва да са съвместими назад (добавяне на колони/таблици), за да работи старият web по време на zero-downtime превключването.
- Zero-downtime: Render пуска новата инстанция, превключва трафика и изпраща SIGTERM на старата. Worker-ите за кратко може да се застъпят — публикуването и outbox са защитени с DB lock/claim/unique (тест с 2 отделни worker процеса + web).

## 6. Първо създаване (бъдеща последователност)

1. GitHub хранилище и push — изпълнено (`docs/PRODUCTION-PREP-REPORT.md`, раздел N).
2. Render Dashboard → New → Blueprint → хранилището → попълни `sync: false` стойностите по таблицата в §3: за първи старт само `APP_BASE_URL` — **еднакъв** в web и worker. Известията (VAPID ключовете се генерират локално с `npx web-push generate-vapid-keys`; публичният — **еднакъв** в web и worker, частният — само в worker-а; SMTP) могат да се добавят по-късно.
3. Изчакай web/worker/db. Провери `/api/health` = 200, `/api/ready` = 503 (празна база — очаквано) и Health в логовете на worker-а: `waiting_data`.
4. Продължи с `docs/CUTOVER-AND-ROLLBACK.md`.
