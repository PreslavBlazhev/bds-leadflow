import { defineConfig, devices } from "@playwright/test";

/**
 * E2E върху production build (next start) на порт 3016 с ОТДЕЛНА e2e база (data/e2e-test.db).
 * Ползва инсталирания Google Chrome (channel: "chrome") — без изтегляне на браузъри.
 */
const PORT = 3016;
/**
 * Артефактите на всеки пуск са в отделна папка (scripts/run-e2e.mjs задава LF_E2E_RUN_DIR):
 *   console.log, summary.json, results.json, html/, artifacts/ (trace, screenshot, video при провал).
 * Playwright чисти само собствения outputDir (artifacts/ на текущия пуск) — предишните пускове остават.
 */
const RUN_DIR = process.env.LF_E2E_RUN_DIR ?? "tests/.tmp/e2e-runs/manual";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: `${RUN_DIR}/artifacts`,
  reporter: [["list"], ["json", { outputFile: `${RUN_DIR}/results.json` }], ["html", { outputFolder: `${RUN_DIR}/html`, open: "never" }]],
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  // Screenshots се правят върху свежата e2e база, преди flow тестовете да променят данните.
  projects: [
    { name: "screens-desktop", testMatch: /screens\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", testMatch: /mobile\.spec\.ts/, use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, channel: "chrome" }, dependencies: ["screens-desktop"] },
    { name: "desktop", testIgnore: /(mobile|screens)\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } }, dependencies: ["mobile"] },
  ],
  webServer: {
    command: `npx tsx tests/e2e/prepare.ts && npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      APP_MODE: "demo",
      DATABASE_URL: "file:../data/e2e-test.db",
      APP_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TICK_SECONDS: "30",
      // T38: фалшиви тайни от scripts/run-e2e.mjs (не трябва да стигнат до браузъра).
      ...(process.env.LF_E2E_FAKE_VAPID_PRIVATE ? { VAPID_PRIVATE_KEY: process.env.LF_E2E_FAKE_VAPID_PRIVATE } : {}),
      ...(process.env.LF_E2E_FAKE_SMTP_PASS ? { SMTP_PASS: process.env.LF_E2E_FAKE_SMTP_PASS } : {}),
    },
    stdout: "pipe",
  },
});
