# Go-live checklist (real режим)

Демото е готово. **LIVE режимът не е.** Минималните стъпки, по приоритет:

## 1. Източник на реални кандидати (най-голям blocker)
- [ ] Избор: лицензиран B2B доставчик (договор, документация, позволена употреба за телефонни продажби) **или** Google Places за CRM употреба (разрешена употреба (3) в ЕИП) с правен преглед.
- [ ] Реализиране на адаптера срещу истинската документация. Field policy (STORE / DISPLAY_ONLY / ID_ONLY) по договора.
- [ ] Budget cap и квота **в кода** (брояч на заявки на ден и спиране), не само billing alert.
- [ ] E2E проверка с реални заявки на тестов град. `LIVE_DISCOVERY_ENABLED=true` едва след това.

## 2. Стара контактна история
- [ ] Експорт на стария Excel в CSV → `Нови клиенти → Импорт CSV` (mapping, preview). Колоните `contacted_before` и `first_issued_at` трябва да са попълнени, където са известни.
- [ ] Преглед на „За проверка“ (неизвестна история, дубликати) преди първия real списък.

## 3. Hosting, база, scheduler
- [ ] Always-on сървър (не „спящ“ безплатен план) с устойчив диск. Два процеса: `next start` + `worker:start` под process manager.
- [ ] SQLite е OK за един процес на една машина. При multi-instance → миграция към PostgreSQL (виж ARCHITECTURE.md — не е само смяна на URL).
- [ ] `APP_MODE=real`, `DATABASE_URL=file:../data/real.db`, `npm run db:migrate`, `npm run owner:create`. **Без** seed.

## 4. HTTPS и достъп
- [ ] Домейн + HTTPS (reverse proxy). `APP_BASE_URL=https://…` (тогава cookie-то е Secure).
- [ ] Rate limit зад proxy: доверие само на собствения proxy за `x-forwarded-for`.

## 5. Известия до мен
- [ ] VAPID ключове за production (`npx web-push generate-vapid-keys`) в `.env` на сървъра. `VAPID_SUBJECT=mailto:<твоят адрес>`.
- [ ] Телефон: отвори сайта през HTTPS → Настройки → „Включи известия“. `ALLOW_REAL_TEST_DELIVERY=true` временно → „Изпрати реален тестов push“ → потвърди на телефона → върни на false.
- [ ] SMTP: доставчик с разрешен sender (`SMTP_FROM`), `OWNER_NOTIFY_EMAIL` = твоят адрес. Тестов имейл по същия начин.

## 6. Правно и данни
- [ ] Основание за обработка на B2B контакти, информиране, право на възражение, правила за директен маркетинг (без автоматична декларация „GDPR compliant“).
- [ ] Retention политика (Настройки → Данни). DNC списъкът се пази за потискане.

## 7. Backup
- [ ] Ежедневен `npm run backup` (cron/Task Scheduler) + копие извън сървъра, криптирано. Тест за възстановяване веднъж месечно.
