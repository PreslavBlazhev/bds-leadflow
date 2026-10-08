import { expect, test } from "@playwright/test";
import { login, noHorizontalOverflow } from "./util";

const ORIGIN = "http://localhost:3016";

/** Засегнатите от production подготовката екрани и публични ресурси (desktop + mobile ширина). */
test.describe("production подготовка", () => {
  test("публични: liveness/readiness само ok/ready; PWA ресурси с относителен scope; разписката не издава нищо", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(Object.keys(await health.json()).sort()).toEqual(["ok", "service"]);
    const ready = await request.get("/api/ready");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    expect(ready.headers()["cache-control"]).toContain("no-store");

    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.start_url).toBe("/today");
    expect(manifest.scope).toBe("/");
    const sw = await request.get("/sw.js");
    expect(sw.headers()["cache-control"]).toContain("no-cache");
    const swText = await sw.text();
    expect(swText).toContain('openWindow("/today")');
    expect(swText).not.toMatch(/localhost|https?:\/\/[a-z]/i); // без вграден origin — работи на canonical HTTPS адреса
    expect(swText).not.toMatch(/caches\.open[^;]*api/); // личните API не се кешират

    // разписка от service worker: без Origin → 403; с непознат token → общ отговор (не издава дали съществува)
    expect((await request.post("/api/push/receipt", { data: { rt: "x".repeat(20), event: "shown" } })).status()).toBe(403);
    const r = await request.post("/api/push/receipt", { headers: { origin: ORIGIN }, data: { rt: "x".repeat(20), event: "shown" } });
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    // анонимно: новите owner действия изискват вход
    for (const p of ["/api/auth/logout-all", "/api/push/check"]) expect((await request.post(p, { headers: { origin: ORIGIN }, data: {} })).status()).toBe(401);
  });

  test("owner: Health показва състоянието на worker-а честно; Известия — „Активирай известията“; Сесии — изход навсякъде", async ({ page }) => {
    await login(page);
    await page.goto("/settings?tab=health");
    const w = page.getByLabel("Състояние на worker-а");
    // в E2E няма стартиран worker → не може да е зелено
    await expect(w).toContainText(/Няма данни от worker|не работи|спрян/);
    await expect(w).toContainText("Последно успешно изпълнение");
    await expect(w).toContainText("SCHEDULER_ENABLED");
    await expect(page.getByText("Worker работи", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${process.env.LF_E2E_RUN_DIR ?? "tests/.tmp/e2e-runs/manual"}/settings-health.png`, fullPage: true });
    await page.goto("/settings?tab=notify");
    await expect(page.getByRole("button", { name: "Активирай известията" }).first()).toBeVisible();
    await page.goto("/settings?tab=data");
    await expect(page.getByRole("button", { name: "Изход от всички устройства" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const t of ["health", "notify", "data"]) {
      await page.goto(`/settings?tab=${t}`);
      await noHorizontalOverflow(page);
    }
  });
});
