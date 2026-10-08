import { expect, test } from "@playwright/test";
import { login, noHorizontalOverflow } from "./util";

/** T46 телефон 390×844: карти, долна навигация, без хоризонтален overflow и застъпване на действията. */
test("T46 mobile screenshots и навигация", async ({ page }) => {
  await login(page);
  const nav = page.getByRole("navigation", { name: "Долна навигация" });
  await expect(nav).toBeVisible();
  for (const label of ["Днес", "Обаждания", "Последващи", "Още"]) await expect(nav.getByRole("link", { name: new RegExp(label) })).toBeVisible();
  const shots: [string, string][] = [
    ["/today", "mobile-today.png"],
    ["/pipeline", "mobile-pipeline.png"],
    ["/settings", "mobile-settings.png"],
    ["/more", "mobile-more.png"],
  ];
  for (const [p, f] of shots) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `docs/screenshots/${f}`, fullPage: false });
  }
  // Обаждания на телефон: постоянен бутон „Запиши резултат“ над долната навигация, без застъпване
  await page.goto("/calls?queue=new");
  const rec = page.getByRole("button", { name: "Запиши резултат" });
  await expect(rec).toBeVisible();
  const rb = (await rec.boundingBox())!;
  const nb = (await nav.boundingBox())!;
  expect(rb.height).toBeGreaterThanOrEqual(40);
  expect(rb.y + rb.height).toBeLessThanOrEqual(nb.y + 1); // над навигацията, не върху нея
  // най-долното съдържание може да се скролне над фиксираната лента
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const lastDetails = page.locator("article").getByText("Подробности (оценка и проверка на сайта)");
  const lb = (await lastDetails.boundingBox())!;
  const rb2 = (await rec.boundingBox())!;
  expect(lb.y + lb.height).toBeLessThanOrEqual(rb2.y - 4);
  // „Предишен / Пропусни“ са в потока на страницата и не се застъпват с бутона
  await page.evaluate(() => window.scrollTo(0, 0));
  const skip = (await page.getByRole("button", { name: "Пропусни засега →" }).boundingBox())!;
  expect(skip.y + skip.height).toBeLessThan((await rec.boundingBox())!.y);
  await page.screenshot({ path: "docs/screenshots/mobile-calls.png" });
  // панелът съдържа всички 9 резултата и бележка; затваряне не губи избора
  // (записът е в „Необработени“, за да не променя „Нови днес“ за следващите тестове)
  await page.goto("/calls?queue=backlog");
  const name = (await page.locator("article h2").first().innerText()).trim();
  await rec.click();
  const sheet = page.getByRole("dialog", { name: /Резултат:/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio")).toHaveCount(9);
  await expect(sheet.getByLabel("Бележка")).toBeVisible();
  await sheet.getByText("Говорихме", { exact: true }).click();
  await sheet.getByLabel("Бележка").fill("Тест от телефон");
  await page.screenshot({ path: "docs/screenshots/mobile-calls-sheet.png" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await rec.click();
  await expect(sheet.getByRole("radio", { name: "Говорихме" })).toBeChecked();
  await expect(sheet.getByLabel("Бележка")).toHaveValue("Тест от телефон");
  const save = sheet.getByRole("button", { name: "Запази и следващ" });
  await save.scrollIntoViewIfNeeded();
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await save.click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(`Записано: Говорихме — ${name}`)).toBeVisible();
  await expect(page.getByText(/Записани в тази сесия: 1 от \d+/)).toBeVisible();
  // таблиците стават карти на телефон
  await page.goto("/today");
  await expect(page.locator("table.data").first()).toBeHidden();
});
