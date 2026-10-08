import { expect, test, type Page } from "@playwright/test";
import { e2eDb, login, noHorizontalOverflow } from "./util";

test.describe.configure({ mode: "serial" });

const PAGES: [string, string][] = [
  ["/today", "Днес"],
  ["/leads", "Нови клиенти / база"],
  ["/calls", "Обаждания"],
  ["/pipeline", "Pipeline"],
  ["/follow-ups", "Последващи действия"],
  ["/offers", "Оферти"],
  ["/clients", "Клиенти"],
  ["/stats", "Статистика"],
  ["/settings", "Настройки"],
  ["/pilot", "Пилот: първи реални бизнеси"],
];

function sofiaTomorrowInput(): string {
  const d = new Date(Date.now() + 86_400_000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T11:00`;
}

async function currentName(page: Page) {
  return (await page.locator("article h2").first().innerText()).trim();
}

test("T45 всички 9 страници се отварят без overflow", async ({ page }) => {
  await login(page);
  for (const [p, h] of PAGES) {
    await page.goto(p);
    await expect(page.getByRole("heading", { level: 1, name: h })).toBeVisible();
    await noHorizontalOverflow(page);
  }
});

test("T45 основен flow: обаждане → follow-up → оферта → won; DNC; idempotent списък; следващ ден", async ({ page }) => {
  const db = e2eDb();
  await login(page);
  await expect(page.getByText("25 / 25").first()).toBeVisible();
  // след публикуване: „Списъкът е готов“, без технически термини
  await expect(page.getByText("✔ Списъкът е готов (25/25)")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/idempotent|backlog/i);
  await expect(page.getByText("Защо тези контакти?")).toBeVisible();

  // 2. score/evidence на избран контакт
  await page.locator("table.data tbody tr").first().getByRole("link").first().click();
  await expect(page.getByRole("complementary", { name: "Детайли на контакт" })).toBeVisible();
  await expect(page.getByText(/Score \d+\/100 — защо/)).toBeVisible();
  await expect(page.getByText("Предложение по шаблон").first()).toBeVisible();

  // 3. разговор → „Да се обадя отново“ → дата/час („Започни обажданията“ отваря само днешните нови)
  await page.goto("/today");
  await page.getByRole("link", { name: /Започни обажданията/ }).click();
  await expect(page).toHaveURL(/\/calls\?queue=new/);
  await expect(page.getByText("Активен списък: контакт 1 от 25")).toBeVisible();
  await expect(page.getByText("Обработени от списъка: 0 от 25")).toBeVisible();
  const n1 = await currentName(page);
  await page.getByText("Да се обадя отново", { exact: true }).click();
  await page.getByLabel("Да, говорихме").check();
  await page.getByLabel(/Дата и час за обратно обаждане/).fill(sofiaTomorrowInput());
  await page.getByRole("button", { name: "Запази и следващ" }).click();
  await expect(page.getByText("Записано: Да се обадя отново")).toBeVisible();
  await expect.poll(() => currentName(page)).not.toBe(n1);
  await expect(page.getByText("Активен списък: контакт 2 от 25")).toBeVisible();
  await expect(page.getByText("Обработени от списъка: 1 от 25")).toBeVisible();

  // 4. втори контакт → „Изпрати оферта“ → чернова
  const n2 = await currentName(page);
  await page.getByText("Изпрати оферта", { exact: true }).click();
  await page.getByRole("button", { name: "Запази и следващ" }).click();
  await expect(page.getByText("Записано: Изпрати оферта")).toBeVisible();
  await expect.poll(() => currentName(page)).not.toBe(n2);

  // 6. трети контакт → DNC
  const n3 = await currentName(page);
  await page.getByText("Не се свързвай повече", { exact: true }).click();
  await page.getByLabel("Да, говорихме").check();
  await page.getByRole("button", { name: "Запази и следващ" }).click();
  await expect(page.getByText("Записано: Не се свързвай повече")).toBeVisible();

  // T48 error state: отказ без причина → видима грешка, нищо не се записва
  const before = await db.activity.count();
  await page.getByText("Отказ", { exact: true }).click();
  await page.getByRole("button", { name: "Запази и следващ" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Посочи причина" })).toBeVisible();
  expect(await db.activity.count()).toBe(before);

  // follow-up се вижда
  await page.goto("/follow-ups?tab=upcoming");
  await expect(page.getByRole("link", { name: n1 })).toBeVisible();

  // 4б. офертата: ръчно „изпратена“ → приета
  await page.goto("/offers?status=DRAFT");
  const card = page.locator("li.card").filter({ hasText: n2 });
  await expect(card.getByText("Чернова", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Маркирай като изпратена (ръчно)" }).click();
  await page.goto("/offers?status=SENT");
  const sent = page.locator("li.card").filter({ hasText: n2 });
  await expect(sent.getByText("Изпратена (ръчно)", { exact: true })).toBeVisible();
  await sent.getByRole("button", { name: "Приета" }).click();
  await page.goto("/offers?status=ACCEPTED");
  await expect(page.locator("li.card").filter({ hasText: n2 })).toBeVisible();
  expect(await db.notificationOutbox.count({ where: { kind: { in: ["TEST_EMAIL"] } } })).toBe(0); // нищо не е „изпратено“ от приложението

  // 5. Won → Client, без получен приход
  const b2 = await db.business.findFirstOrThrow({ where: { name: n2 } });
  await page.goto(`/leads/${b2.id}`);
  await page.getByText("Спечелен клиент", { exact: true }).click();
  await page.getByRole("button", { name: "Запази резултата" }).click();
  await expect(page.getByText("Записано: Спечелен клиент")).toBeVisible();
  await page.goto("/clients");
  const cl = page.locator("li.card").filter({ hasText: n2 });
  await expect(cl).toBeVisible();
  await expect(cl).toContainText(/получено 0,00/);
  const client = await db.client.findUniqueOrThrow({ where: { businessId: b2.id }, include: { payments: true } });
  expect(client.payments).toHaveLength(0);

  // 6б. DNC блокиран в UI и backend
  const b3 = await db.business.findFirstOrThrow({ where: { name: n3 } });
  await page.goto(`/leads/${b3.id}`);
  await expect(page.getByText("Обажданията са блокирани.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Позвъни" })).toBeDisabled();
  const api = await page.evaluate(async (id) => (await fetch("/api/outcomes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessId: id, outcome: "SPOKE", idempotencyKey: "idem-e2e-dnc-1" }) })).status, b3.id);
  expect(api).toBe(409);

  // 8. повторно генериране на същия ден → същият списък
  await page.goto("/today");
  const today = (await db.dailyBatch.findFirstOrThrow({ orderBy: { localDate: "desc" } })).localDate;
  const ids1 = (await db.dailyBatchItem.findMany({ where: { batch: { localDate: today } }, orderBy: { position: "asc" } })).map((i) => i.businessId);
  await expect(page.getByText("✔ Списъкът е готов (25/25)")).toBeVisible();
  // защитата остава: повторна заявка за публикуване не създава нов списък
  await page.getByRole("button", { name: "Създай списък", exact: true }).click();
  await expect(page.getByText(/Вече съществува: 25\/25/)).toBeVisible();
  const again = await page.evaluate(async () => (await fetch("/api/batch/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
  expect(again).toMatchObject({ created: false, added: 0, total: 25 });
  const ids2 = (await db.dailyBatchItem.findMany({ where: { batch: { localDate: today } }, orderBy: { position: "asc" } })).map((i) => i.businessId);
  expect(ids2).toEqual(ids1);

  // 7. следващ demo ден → 25 други canonical IDs
  await page.getByRole("button", { name: "Симулирай следващ ден" }).click();
  await page.getByRole("button", { name: "Потвърди: следващ демо ден" }).click();
  await expect(page.getByText(/Демо ден .*: 25\/25 нови/)).toBeVisible({ timeout: 30_000 });
  const batches = await db.dailyBatch.findMany({ orderBy: { localDate: "asc" }, include: { items: true } });
  const last = batches.at(-1)!;
  expect(last.localDate > today).toBe(true);
  const prior = new Set(batches.slice(0, -1).flatMap((b) => b.items.map((i) => i.businessId)));
  expect(last.items).toHaveLength(25);
  expect(last.items.filter((i) => prior.has(i.businessId))).toHaveLength(0);

  // 9. simulated push/email preview
  await page.goto("/today");
  await page.getByRole("button", { name: "Покажи известието" }).click();
  const dlg = page.getByRole("dialog", { name: /НЕ е изпратено/ });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(/Днешният списък е готов: 25 нови контакта/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();

  // реалната статистика от действията
  await page.goto("/stats");
  await expect(page.getByText("Записани опити")).toBeVisible();
  await db.$disconnect();
});

test("опашки: отделни броячи, без повторения, старите остават стари", async ({ page }) => {
  const db = e2eDb();
  await login(page);
  const statOld = Number((await page.locator(".card", { hasText: "Необработени от предишни дни" }).first().locator(".tabular").first().innerText()).trim());
  expect(statOld).toBeGreaterThan(0);
  await page.goto("/calls?queue=backlog");
  const tabs = page.getByRole("navigation", { name: "Опашка" });
  await expect(tabs.getByRole("link", { name: /Необработени от предишни дни/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(new RegExp(`Необработени от предишни дни: контакт 1 от ${statOld}$`))).toBeVisible();
  const today = (await db.dailyBatch.findFirstOrThrow({ orderBy: { localDate: "desc" } })).localDate;
  // обхождане на цялата опашка: нито един бизнес не се повтаря и всеки е от предишен ден
  const seen = new Set<string>();
  for (let k = 0; k < statOld; k++) {
    const nm = await currentName(page);
    expect(seen.has(nm)).toBe(false);
    seen.add(nm);
    const b = await db.business.findFirstOrThrow({ where: { name: nm }, include: { batchItem: { include: { batch: true } } } });
    expect(b.batchItem!.batch.localDate < today).toBe(true);
    if (k < statOld - 1) {
      await page.getByRole("button", { name: "Пропусни засега →" }).click();
      await expect(page.getByText(new RegExp(`контакт ${k + 2} от ${statOld}$`))).toBeVisible();
    }
  }
  expect(seen.size).toBe(statOld);
  await page.goto("/calls?queue=followups");
  await expect(page.getByText(/За повторно обаждане: контакт 1 от \d+|Няма контакти в „За повторно обаждане“/)).toBeVisible();
  await db.$disconnect();
});

test("T47 клавиатура: видим focus, dialog с Escape и връщане на фокуса, labels", async ({ page }) => {
  await login(page);
  // Обаждания: клавиш 2 избира „Говорихме“, записът става с клавиатура
  await page.goto("/calls?queue=new");
  const nm = await currentName(page);
  await page.locator("body").press("2");
  await expect(page.getByRole("radio", { name: "Говорихме" })).toBeChecked();
  await page.getByRole("button", { name: "Запази и следващ" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(`Записано: Говорихме — ${nm}`)).toBeVisible();
  await page.goto("/leads");
  const btn = page.getByRole("button", { name: "Добави ръчно" });
  await btn.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Ръчно добавяне на бизнес" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel("Име *")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(btn).toBeFocused();
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(outline).not.toBe("none");
  // всички input/select/textarea на страницата за настройки имат етикет
  await page.goto("/settings");
  const unlabeled = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main input:not([type=hidden]), main select, main textarea")).filter((el) => {
      const id = el.getAttribute("id");
      return !(el.closest("label") || (id && document.querySelector(`label[for="${id}"]`)) || el.getAttribute("aria-label"));
    }).length,
  );
  expect(unlabeled).toBe(0);
});

test("T48 empty / partial / недостатъчно данни states", async ({ page }) => {
  await login(page);
  await page.goto("/leads?q=zzzzqqq");
  await expect(page.getByText("Няма записи по тези филтри.")).toBeVisible();
  await page.goto("/stats?from=2020-01-01&to=2020-01-31");
  await expect(page.getByText("недостатъчно данни").first()).toBeVisible();
  await expect(page.getByText(/Новоразпределени/)).toBeVisible();
  // частичен списък: цел 200 (макс.) при по-малък резерв
  const r = await page.evaluate(async () => {
    const s = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    return s.status;
  });
  expect(r).toBe(400); // празни настройки се отхвърлят от Zod
  await page.goto("/settings");
  await page.getByLabel("Дневна цел (нови)").fill("200");
  await page.getByRole("button", { name: "Запази настройките" }).click();
  await expect(page.getByText(/Запазено/)).toBeVisible();
  await page.goto("/today");
  await page.getByRole("button", { name: "Симулирай следващ ден" }).click();
  await page.getByRole("button", { name: "Потвърди: следващ демо ден" }).click();
  await expect(page.getByText(/Демо ден .*: \d+\/200 нови/)).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByText(/Частичен списък: Само \d+ от 200/)).toBeVisible();
  // връщане на целта
  await page.goto("/settings");
  await page.getByLabel("Дневна цел (нови)").fill("25");
  await page.getByRole("button", { name: "Запази настройките" }).click();
  await expect(page.getByText(/Запазено/)).toBeVisible();
});
