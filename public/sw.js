/* BDS LeadFlow service worker.
 * - Кешира САМО безопасния offline shell и иконите.
 * - НЕ кешира private API отговори, auth страници, CRM HTML или контакти.
 * - Без offline редакции/синхронизация.
 * - Всички адреси са относителни към origin-а, от който е регистриран (production: canonical HTTPS адресът).
 * - Разписки: след показване ("shown") и при натискане ("clicked") — POST /api/push/receipt с еднократния token
 *   от payload-а. Разписката НЕ доказва, че известието е прочетено; при липса на мрежа просто не пристига.
 */
const SHELL = "lf-shell-v2";
const SHELL_FILES = ["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Навигации: винаги мрежа; само при липса на връзка — статичен offline shell (без CRM данни).
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
    return;
  }
  // Иконите/manifest от кеша; всичко останало (вкл. /api/*) минава директно през мрежата, без кеширане.
  if (SHELL_FILES.includes(url.pathname)) e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

function receipt(rt, event) {
  if (!rt) return Promise.resolve();
  return fetch("/api/push/receipt", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rt, event }),
  }).catch(() => {});
}

self.addEventListener("push", (e) => {
  let data = { title: "BDS LeadFlow", body: "Има ново известие.", url: "/today", rt: null };
  try {
    data = Object.assign(data, e.data ? e.data.json() : {});
  } catch (_) {}
  // Payload-ът не съдържа имена/телефони на клиенти. Отваря се винаги /today на този origin.
  e.waitUntil(
    self.registration
      .showNotification(data.title, { body: data.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "lf-daily", data: { url: "/today", rt: data.rt } })
      .then(() => receipt(data.rt, "shown")),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const rt = e.notification.data && e.notification.data.rt;
  // Винаги към защитения /today (login при нужда). Без secret-bearing URL.
  e.waitUntil(
    Promise.all([
      receipt(rt, "clicked"),
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const c of list) if (new URL(c.url).origin === self.location.origin && "focus" in c) return c.navigate("/today").then((w) => (w || c).focus());
        return self.clients.openWindow("/today");
      }),
    ]),
  );
});

// Браузърът е сменил абонамента (изтекъл/подновен ключ): нов абонамент със същия VAPID ключ и регистрация в сървъра.
// Ако няма валидна сесия, регистрацията се отказва (401) и Настройки → Известия показва „устройството не е регистрирано“.
self.addEventListener("pushsubscriptionchange", (e) => {
  const old = e.oldSubscription;
  const key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  e.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) => {
        const j = sub.toJSON();
        return fetch("/api/push/subscribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, label: "Подновен абонамент" }),
        });
      })
      .catch(() => {}),
  );
});
