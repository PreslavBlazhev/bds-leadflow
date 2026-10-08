import { expect, test } from "@playwright/test";
import path from "node:path";
import { createDb } from "@/lib/db";
import { systemClock } from "@/lib/time";
import { EXPECTED_HEADERS, importBusinessFile, parseBusinessFile, parseRanges } from "@/domain/xlsxImport";
import { buildXlsx, type FxCell } from "../integration/xlsxFixture";
import { login, noHorizontalOverflow } from "./util";

test.describe.configure({ mode: "serial" });

/** Последен в e2e: превключва e2e базата към реален източник с СИНТЕТИЧЕН файл (валидни формати, никога не набирани номера). */
test("реален източник: импорт от Excel, панел „Реални списъци“, без демо в опашките, полета в картата", async ({ page }) => {
  const rows: FxCell[][] = [[...EXPECTED_HEADERS]];
  const today = new Date().toISOString().slice(0, 10);
  const serial = Date.parse(`${today}T00:00:00Z`) / 86_400_000 + 25569;
  for (let i = 1; i <= 28; i++) {
    const u = `https://www.google.com/maps/place/E2E+${i}/data=!4m7!3m6!8m2!3d43.2!4d27.9!19sChIJE2E${String(i).padStart(4, "0")}?hl=en`;
    rows.push([
      i,
      `Е2Е Реален ${i}`,
      i % 2 ? "Автоуслуги" : "Красота и грижа",
      i % 2 ? "Автосервиз" : "Маникюр и педикюр",
      "Център",
      `ул. Е2Е ${i}, 9000 Варна`,
      `+35988977${String(1000 + i)}`,
      null,
      { f: `IFERROR(HYPERLINK(_xlfn._LONGTEXT("${u.slice(0, 50)}","${u.slice(50)}"),"Google Maps"),"Google Maps")`, v: "Google Maps" },
      4.6,
      40,
      "Пн–Пт: 09:00–18:00",
      "Няма открит собствен сайт",
      null,
      null,
      null,
      "Преди 1 месец (видим отзив)",
      serial,
      "Средна",
      null,
      i <= 15 ? "A — висок приоритет" : "B — среден приоритет",
    ]);
  }
  const buf = buildXlsx([{ name: "Основен списък", rows }]);
  const db = await createDb(`file:${path.resolve("data/e2e-test.db").split(path.sep).join("/")}`);
  try {
    const rep = await importBusinessFile({ db, mode: "demo", clock: systemClock, actor: "e2e" }, parseBusinessFile(buf, "e2e.xlsx"), {
      calledBefore: parseRanges("1-5"),
      confirmOthersNotCalled: true,
      activateRealSource: true,
    });
    expect(rep.created).toBe(28);
  } finally {
    await db.$disconnect();
  }

  await login(page);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Запас и следващ нов списък" })).toBeVisible();
  await expect(page.getByText("Следващ нов списък:").first()).toBeVisible();
  await expect(page.getByText(/Запасът е под дневната цел: само 23 допустими/)).toBeVisible();
  await expect(page.getByText(/Преглед: следващите 23 реални кандидата/)).toBeVisible();
  await expect(page.getByText("Реални списъци · демо история запазена")).toBeVisible();
  await expect(page.getByRole("link", { name: /Повторни обаждания \(\d+\)/ })).toBeVisible(); // няма активен реален списък; демо не се брои
  await expect(page.getByText("Остават в активния")).toBeVisible();
  await expect(page.getByText(/Няма активен списък\./)).toBeVisible();
  await page.screenshot({ path: `${process.env.LF_E2E_RUN_DIR ?? "tests/.tmp/e2e-runs/manual"}/real-today.png`, fullPage: true });
  await noHorizontalOverflow(page);

  // Опашките: днешният демо списък не влиза; прозвънените (1–5) не са в прегледа
  await page.goto("/calls?queue=new");
  await expect(page.getByRole("link", { name: /Активен списък/ })).toContainText("0");
  const text = await page.goto("/today").then(() => page.locator("details", { hasText: "Преглед: следващите" }).innerText());
  for (const i of [1, 2, 3, 4, 5]) expect(text).not.toMatch(new RegExp(`Е2Е Реален ${i}\\b`));

  // Карта на реален контакт: полетата от файла, историята и реално „Позвъни“
  await page.getByRole("link", { name: "Е2Е Реален 7", exact: true }).first().click();
  const card = page.getByRole("article", { name: /Детайли: Е2Е Реален 7/ });
  await expect(card.getByText("Наблюдение в източника")).toBeVisible();
  await expect(card.getByText("Още не е звъняно (потвърдено от собственика)")).toBeVisible();
  await expect(card.getByText("e2e.xlsx / Основен списък / №7")).toBeVisible();
  await expect(card.getByRole("button", { name: "Позвъни" })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/today");
  await noHorizontalOverflow(page);
});

test("активен списък от предишна дата: 20 от 23 обработени → „Продължи останалите 3“; „Не отговори“ с изчислена дата", async ({ page }) => {
  // Реален списък от минала дата с 23-те допустими Е2Е бизнеса; 20 с устойчиво „обработен“.
  const db = await createDb(`file:${path.resolve("data/e2e-test.db").split(path.sep).join("/")}`);
  try {
    const biz = await db.business.findMany({ where: { sourceName: "e2e.xlsx", priorContact: "NOT_CALLED" }, orderBy: { sourceRowNo: "asc" } });
    expect(biz).toHaveLength(23);
    const issuedAt = new Date("2026-01-05T06:00:00Z");
    const batch = await db.dailyBatch.create({ data: { localDate: "2026-01-05", target: 25, scheduledAt: issuedAt, publishedAt: issuedAt, quotaPlan: "{}", shortfallReason: "Само 23 от 25" } });
    for (const [i, b] of biz.entries()) {
      await db.dailyBatchItem.create({
        data: { batchId: batch.id, businessId: b.id, position: i + 1, bucket: "Варна", scoreAtIssue: 50, reason: "е2е", issuedAt, ...(i < 20 ? { processedAt: new Date("2026-01-05T10:00:00Z"), processedOutcome: "SPOKE" } : {}) },
      });
      await db.business.update({ where: { id: b.id }, data: { firstIssuedAt: issuedAt } });
    }
  } finally {
    await db.$disconnect();
  }
  await login(page);
  await page.goto("/today");
  await expect(page.getByText("Активен списък от 05.01.2026").first()).toBeVisible();
  await expect(page.getByText(/Обработени:\s*20 от 23/)).toBeVisible();
  await expect(page.getByText(/Остават\s*3\s*контакта/)).toBeVisible();
  await expect(page.getByText(/Следващият списък ще бъде издаден след приключването им, в следващия работен ден в 08:00\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /Създай днешния списък|Допълни днешния списък/ }).or(page.getByText(/За днес вече има издаден списък/))).toBeVisible();
  await page.screenshot({ path: `${process.env.LF_E2E_RUN_DIR ?? "tests/.tmp/e2e-runs/manual"}/active-list-today.png`, fullPage: false });
  await page.getByRole("link", { name: "Продължи останалите 3" }).click();
  await page.waitForURL(/\/calls\?queue=new/);
  await expect(page.getByRole("link", { name: /Активен списък/ })).toContainText("3");
  await expect(page.getByText(/Активен списък от 05\.01\.2026 · №21/).first()).toBeVisible();
  // „Не отговори“: датата е изчислена предварително; след записа се показва действителната дата
  const form = page.getByRole("complementary", { name: "Запис на резултат" });
  await form.getByText("Не отговори", { exact: true }).click();
  const when = form.locator('input[type="datetime-local"]');
  await expect(when).not.toHaveValue("");
  await expect(form.getByText(/изчислено след 2 работни дни/)).toBeVisible();
  await page.screenshot({ path: `${process.env.LF_E2E_RUN_DIR ?? "tests/.tmp/e2e-runs/manual"}/no-answer-form.png`, fullPage: false });
  await form.getByRole("button", { name: "Запази и следващ" }).click();
  await expect(page.getByText(/повторно обаждане: \d{2}\.\d{2}\.\d{4}/).first()).toBeVisible();
  await page.goto("/today");
  await expect(page.getByText(/Обработени:\s*21 от 23/)).toBeVisible();
});
