import { expect, test } from "@playwright/test";
import { login, noHorizontalOverflow } from "./util";

/** T46 desktop 1440×900: реални screenshots в docs/screenshots. */
test("T46 desktop screenshots", async ({ page }) => {
  await login(page);
  const shots: [string, string][] = [
    ["/today", "desktop-today.png"],
    ["/calls", "desktop-calls.png"],
    ["/pipeline", "desktop-pipeline.png"],
    ["/settings", "desktop-settings.png"],
    ["/settings?tab=health", "desktop-settings-health.png"],
    ["/leads", "desktop-leads.png"],
  ];
  for (const [p, f] of shots) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `docs/screenshots/${f}` });
  }
  // Обаждания на desktop: име, телефон, бележка, деветте резултата и „Запази и следващ“ са видими без скролване
  await page.goto("/calls?queue=new");
  for (const loc of [page.locator("article h2").first(), page.getByText(/\+359 XX XXX/).first(), page.getByLabel("Бележка"), page.getByRole("button", { name: "Запази и следващ" })]) {
    const bb = (await loc.boundingBox())!;
    expect(bb.y + bb.height).toBeLessThanOrEqual(900);
  }
  await expect(page.getByRole("radio")).toHaveCount(9);
  const overflowing = await page.evaluate(() =>
    Array.from(document.querySelectorAll("label")).filter((l) => l.querySelector('input[type="radio"][name^="outcome-"]') && l.scrollWidth > l.clientWidth + 1).length,
  );
  expect(overflowing).toBe(0);
  // detail panel с score/evidence
  await page.goto("/today");
  await page.locator("table.data tbody tr").nth(1).getByRole("link").first().click();
  await expect(page.getByRole("complementary", { name: "Детайли на контакт" })).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/desktop-today-detail.png" });
});
