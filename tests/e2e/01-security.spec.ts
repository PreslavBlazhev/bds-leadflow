import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { login } from "./util";

const ORIGIN = "http://localhost:3016";

test.describe("T36 неавторизиран достъп", () => {
  test("страници пренасочват към login; API, export, job trigger и settings връщат 401", async ({ page, request }) => {
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login\?next=%2Ftoday/);
    for (const p of ["/leads", "/settings", "/calls", "/offers/x/print"]) {
      await page.goto(p);
      await expect(page).toHaveURL(/\/login/);
    }
    const h = { origin: ORIGIN, "content-type": "application/json" };
    expect((await request.get("/api/export/leads")).status()).toBe(401);
    expect((await request.get("/api/batch/preview")).status()).toBe(401);
    expect((await request.post("/api/batch/publish", { headers: h, data: {} })).status()).toBe(401);
    expect((await request.post("/api/batch/next-day", { headers: h, data: {} })).status()).toBe(401);
    expect((await request.put("/api/settings", { headers: h, data: {} })).status()).toBe(401);
    expect((await request.post("/api/outcomes", { headers: h, data: {} })).status()).toBe(401);
    expect((await request.get("/api/notifications/preview")).status()).toBe(401);
    // публичната health проверка не издава CRM данни
    const health = await (await request.get("/api/health")).json();
    expect(Object.keys(health).sort()).toEqual(["ok", "service"]);
  });
});

test.describe("T37 CSRF, валидация, опасни URL", () => {
  test("чужд/липсващ Origin → 403; невалидни данни → 400 с ясна грешка", async ({ page }) => {
    await login(page);
    const res = await page.evaluate(async () => {
      const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, j: await r.json() }));
      return {
        badOutcome: await post("/api/outcomes", { businessId: "x", outcome: "CALLED_ALL", idempotencyKey: "idem-e2e-0001" }),
        jsUrl: await post("/api/leads", { name: "ТЕСТ XSS", city: "Варна", category: "auto", website: "javascript:alert(1)", usageConfirmed: true, sourceNote: "e2e" }),
        noUsage: await post("/api/leads", { name: "ТЕСТ", city: "Варна", category: "auto", usageConfirmed: false, sourceNote: "e2e" }),
        badJson: await fetch("/api/outcomes", { method: "POST", headers: { "content-type": "application/json" }, body: "{не е json" }).then((r) => r.status),
      };
    });
    expect(res.badOutcome.s).toBe(400);
    expect(res.jsUrl.s).toBe(400);
    expect(res.jsUrl.j.error).toMatch(/http\/https/);
    expect(res.noUsage.s).toBe(400);
    expect(res.badJson).toBe(400);
    // Сесийната бисквитка + чужд Origin
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const evil = await page.request.post("/api/batch/publish", { headers: { origin: "https://evil.example", cookie, "content-type": "application/json" }, data: {} });
    expect(evil.status()).toBe(403);
    const noOrigin = await fetch(`${ORIGIN}/api/batch/publish`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const cookieAttrs = cookies.find((c) => c.name === "lf_session")!;
    expect(cookieAttrs.httpOnly).toBe(true);
    expect(cookieAttrs.sameSite).toBe("Lax");
  });
});

test.describe("T38 няма тайни в client bundle", () => {
  test("заредените JS/HTML не съдържат VAPID private key или SMTP парола", async ({ page }) => {
    const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
    const secrets = [
      ...["VAPID_PRIVATE_KEY", "SMTP_PASS", "GOOGLE_PLACES_API_KEY"].map((k) => new RegExp(`^${k}=(.+)$`, "m").exec(env)?.[1]?.trim()),
      process.env.LF_E2E_FAKE_VAPID_PRIVATE, // фалшиви тайни за пуска (scripts/run-e2e.mjs) — работи и без .env (чисто копие/CI)
      process.env.LF_E2E_FAKE_SMTP_PASS,
    ].filter((v): v is string => !!v && v.length > 6);
    expect(secrets.length).toBeGreaterThan(0);
    const bodies: string[] = [];
    page.on("response", async (r) => {
      const ct = r.headers()["content-type"] ?? "";
      if (/javascript|html|json/.test(ct)) bodies.push(await r.text().catch(() => ""));
    });
    await login(page);
    for (const p of ["/today", "/settings?tab=notify", "/settings?tab=providers", "/calls"]) await page.goto(p);
    await page.waitForLoadState("networkidle");
    expect(bodies.length).toBeGreaterThan(5);
    for (const s of secrets) for (const b of bodies) expect(b.includes(s)).toBe(false);
    // статичните chunk-ове на build-а
    const dir = ".next/static/chunks";
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".js"));
    for (const f of files) {
      const txt = fs.readFileSync(`${dir}/${f}`, "utf8");
      for (const s of secrets) expect(txt.includes(s), f).toBe(false);
    }
  });
});

test.describe("T44 service worker кеш и logout", () => {
  test("SW кешира само shell; след logout няма достъп", async ({ page }) => {
    await login(page);
    await page.goto("/today");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto("/leads");
    await page.goto("/today");
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out.sort();
    });
    expect(cached).toEqual(["/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest", "/offline.html"]);
    expect(cached.some((p) => p.startsWith("/api") || p === "/today" || p === "/login")).toBe(false);
    await page.getByRole("button", { name: "Изход" }).click();
    await page.waitForURL(/\/login/);
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => fetch("/api/export/leads").then((r) => r.status))).toBe(401);
  });
});
