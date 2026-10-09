# Render: настройка (бъдеща стъпка — нищо не е създадено)

Статус към 09.10.2026: `render.yaml` е **локално валидиран** срещу официалната JSON schema (`https://render.com/schema/render.yaml.json`, изтеглена на 08.10.2026) с `node scripts/validate-render-yaml.mjs`. Не е създаден нито един Render ресурс, няма deploy и няма GitHub remote. Локалната schema проверка не доказва, че услугите ще стартират в Render.

## 1. Архитектура (render.yaml)

| Ресурс | Тип / план | Команди | Бележки |
| --- | --- | --- | --- |
| `bds-leadflow-web` | web, node, `0.5c-512mb`, frankfurt | build `npm ci --include=dev && npm run build`; preDeploy `npm run db:deploy`; start `exec node scripts/start-web.mjs` (без npm, с exec — SIGTERM трябва да стигне до процеса) | health `/api/health`; `next start` на `0.0.0.0:$PORT`; graceful shutdown 30 s |
| `bds-leadflow-worker` | Background Worker, node, `0.5c-512mb`, frankfurt | build `npm ci --include=dev`; start `exec node --import tsx src/worker/index.ts` (без npm, с exec; SIGTERM тест в CI на Linux) | един постоянен процес; SIGTERM → изчаква tick-а, освобождава lease-овете; 60 s |
| `bds-leadflow-db` | PostgreSQL 18, `0.1c-256mb`, 5 GB, frankfurt | — | `ipAllowList: []` (само вътрешни връзки); платена → PITR и logical exports от Render |
| env група `leadflow-shared` | — | — | APP_ENV, APP_MODE, APP_BASE_URL, публичния VAPID ключ, DELIVERIES_ENABLED, NOTIFY_DRY_RUN, WORKER_STALE_SECONDS — **една** стойност за двете услуги |

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

- Тайните са само `sync: false` → Render ги пита **при първото създаване** на Blueprint-а; после се сменят от Dashboard. Стойностите не са в Git, логове, отчети или чат.
- Общите стойности (APP_BASE_URL, публичният VAPID ключ) са в групата `leadflow-shared`. Частният VAPID ключ и SMTP са **само** в worker-а. **Не** използвай `generateValue` за общ secret — всяка услуга получава различна генерирана стойност.
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

1. Частно GitHub хранилище, push на `main` (виж `docs/PRODUCTION-PREP-REPORT.md`, раздел M).
2. Render Dashboard → New → Blueprint → хранилището → попълни `sync: false` стойностите (APP_BASE_URL може първо да е onrender адресът; VAPID ключовете се генерират локално с `npx web-push generate-vapid-keys`, частният — само в worker-а).
3. Изчакай web/worker/db. Провери `/api/health` = 200, `/api/ready` = 503 (празна база — очаквано) и Health в логовете на worker-а: `waiting_data`.
4. Продължи с `docs/CUTOVER-AND-ROLLBACK.md`.
