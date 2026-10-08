# Cutover към Render и rollback (бъдеща процедура)

В този етап е направен само **локален rehearsal с копия** (`docs/DATABASE-MIGRATION.md` §4). Реалният cutover не е изпълняван; локалната система продължава да работи на http://localhost:3015 и остава авторитетна до стъпка 9.

Предпоставки: `docs/RENDER-SETUP.md` §6 е изпълнен (web/worker/db създадени, gates изключени); локално има Node 24 и PostgreSQL client 18 (`PG_BIN` или портативния `.tools/pgsql/bin`).

## Последователност

1. **Deploy с изключени gates.** В Render: `SCHEDULER_ENABLED=false`, `DELIVERIES_ENABLED=false`. Web е deploy-нат (preDeploy е приложил миграциите), worker работи.
2. **Schema/readiness.** `https://<адрес>/api/health` → 200. `/api/ready` → 503 (празна база — очаквано). Логът на worker-а: `waiting_data`.
3. **Кратък прозорец без локални записи.** Не записвай обаждания. Спри локалната система: Ctrl+C в терминала с `npm run dev:all` (спира web и локалния worker). Ако е след 08:00, отбележи дали днешният списък вече е издаден локално.
4. **Финален консистентен export** (различен от тестовия):
   ```powershell
   cd "C:\Users\The King\Desktop\Sites\15. BDS LeadFlow"
   npm run migrate:export
   npm run migrate:dry-run -- --archive "backups\migration\<време>\archive.json.gz"
   ```
5. **Импорт и сверяване в production.** В Render → bds-leadflow-db → Networking временно добави своя IP в allow list. Копирай **External** URL (не го поставяй в чат/лог) и:
   ```powershell
   $env:TARGET_DATABASE_URL = "<External URL>?sslmode=require"
   npm run migrate:dry-run -- --archive "backups\migration\<време>\archive.json.gz"   # цел: schema OK, празна
   npm run migrate:import  -- --archive "backups\migration\<време>\archive.json.gz"
   npm run migrate:verify  -- --archive "backups\migration\<време>\archive.json.gz"   # трябва: Резултат: PASS
   Remove-Item Env:TARGET_DATABASE_URL
   ```
   Махни своя IP от allow list. `/api/ready` → 200. Повторен импорт със същия архив = 0 промени; друг архив → отказ.
6. **Owner вход със същата парола** на HTTPS адреса (сесиите не се пренасят). Провери: Днес — активният списък и „Обработени X от Y“ са като локално; Обаждания → Активен списък / За повторно обаждане; бройката „Запас“; Настройки → Health (worker: „графикът е изключен“).
7. **Push и имейл.** На телефона: отвори HTTPS адреса (iPhone: „Добави към началния екран“ и отвори оттам) → Настройки → Известия → „Активирай известията“ (localhost абонаментите не важат и са маркирани като отменени). Задай SMTP стойностите и `OWNER_NOTIFY_EMAIL` в worker-а. За проверка: `NOTIFY_DRY_RUN=true` + `DELIVERIES_ENABLED=true` (изгражда без изпращане), после реален тест: `ALLOW_REAL_TEST_DELIVERY=true` в web → „Изпрати реален тестов push/имейл“ → върни на `false`. Виж `docs/NOTIFICATIONS-SETUP.md`.
8. **Включване само в облака.** В Render: worker `SCHEDULER_ENABLED=true`; групата `DELIVERIES_ENABLED=true`, `NOTIFY_DRY_RUN=false`. Задържаните пренесени известия:
   ```powershell
   # в Render Shell на worker-а (DATABASE_URL е зададен там):
   npm run notifications:release              # показва
   npm run notifications:release -- --apply   # днешните → в опашката (ако списъкът още не е отворен), останалите → skipped
   ```
9. **Облачната база е авторитетна.** Локалният worker остава спрян за реална работа. Не стартирай `npm run dev:all` върху старата база за реални обаждания (за преглед — само с изключена мрежа или копие).

### Ако cutover-ът е след 08:00

Пренасят се и списъците, и `JobRun` (`publish:<дата>`), и timestamp историята:
- ако днешният списък е издаден локално → в облака **няма** втори (уникална местна дата + job ключ); известието за него е `cutover_hold` и се пуска само ако още е актуално (`notifications:release`);
- ако не е издаден и условията към 08:00 са били изпълнени (предишният списък приключен преди 08:00) → облачният worker публикува закъснял списък само за днес, след стъпка 8;
- ако в 08:00 е имало необработени контакти → за днес нов списък няма, независимо кога ги приключиш. Известия за минали дати никога не се изпращат (`skipped`).

## Rollback

Безопасният rollback **не губи** записите, направени в облака.

- **Преди стъпка 8 (нищо ново в облака):** спри услугите в Render (Suspend), върни се към локалната система (`npm run dev:all`). Локалната база не е променяна от преноса.
- **След като в облака има нови записи:**
  1. Спри записите: Suspend на web и worker (или `SCHEDULER_ENABLED=false` + без обаждания).
  2. Направи PostgreSQL backup: `$env:BACKUP_DATABASE_URL="<External URL>?sslmode=require"; npm run pg:backup` (+ временен IP в allow list).
  3. **Не** възстановявай стария SQLite snapshot върху новите записи. Ако все пак трябва да се работи локално, новите облачни записи се пренасят ръчно/с проверка обратно (обаждания, резултати, DNC, follow-ups) и се сверяват с отчета — няма автоматизиран обратен пренос, за да няма автоматична загуба на данни.
  4. По-добрият вариант обикновено е forward fix: връщане на предишен deploy в Render (Rollback на deploy-а), докато базата остава същата — миграциите са само добавящи.

## Backup на PostgreSQL

```powershell
$env:BACKUP_DATABASE_URL = "<URL>"            # production: External URL?sslmode=require (+ временен IP)
npm run pg:backup                              # backups\pg\leadflow-<време>.dump + .manifest.json (бройки от същия snapshot)
$env:RESTORE_DATABASE_URL = "<ОТДЕЛНА празна база>"
npm run pg:restore-check -- --dump "backups\pg\leadflow-<време>.dump"
```

- `pg_dump`/`pg_restore` трябва да са с major ≥ сървъра (Render: 18). Custom формат, `--no-owner --no-privileges` → преносим към друга PostgreSQL база.
- Restore проверката отказва непразна база и базата, от която е направен backup-ът. Restore-ът е в една транзакция.
- **Проверено локално:** dump на пренесената rehearsal база (4083 реда, 33 таблици) → restore в отделна база → бройките съвпадат с manifest-а; `migrate:verify` на възстановената база спрямо архива — PASS.
- Render: платената база има point-in-time recovery и logical exports — но това не е единственото копие. Временната файлова система на Render услугите **не** е място за backup.
- Трайна дестинация (бъдещо решение, нищо не е създадено): криптиран архив (напр. 7-Zip AES-256 с парола в password manager) на отделен диск или облачно хранилище с версии и lifecycle (Backblaze B2/S3 с SSE), месечна restore проверка с `pg:restore-check`. Dump-овете и миграционните архиви съдържат CRM данни — никога в Git, имейл или чат.
