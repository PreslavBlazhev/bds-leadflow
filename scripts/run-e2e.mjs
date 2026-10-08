// npm run test:e2e — build + Playwright с ПОСТОЯННИ логове за всеки пуск.
// Папка: tests/.tmp/e2e-runs/<UTC timestamp>/ → console.log, summary.json, results.json, html/, artifacts/
// (trace/screenshot/video при провал). Предишните пускове не се изтриват.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { runningDevServer } from "./guard-no-dev.mjs";

// E2E прави production build в същата .next — не и докато dev сървърът на тази папка работи.
const dev = runningDevServer();
if (dev && process.env.LF_ALLOW_BUILD_WITH_DEV !== "1") {
  console.error(`[e2e] Отказ: в тази папка работи next dev (pid ${dev.pid}, ${dev.appUrl}). Спри npm run dev:all и пусни отново.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.resolve("tests/.tmp/e2e-runs", stamp);
fs.mkdirSync(runDir, { recursive: true });
const log = fs.createWriteStream(path.join(runDir, "console.log"));
const isWin = process.platform === "win32";
const extraArgs = process.argv.slice(2);

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

function run(phase, cmd, args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    log.write(`\n===== [${phase}] ${cmd} ${args.join(" ")} (${new Date().toISOString()})\n`);
    const p = spawn(cmd, args, { shell: isWin, env: { ...process.env, ...env, FORCE_COLOR: "0" } });
    const out = (d) => {
      process.stdout.write(d);
      log.write(d);
    };
    p.stdout.on("data", out);
    p.stderr.on("data", out);
    p.on("close", (code) => resolve({ phase, code: code ?? 1, ms: Date.now() - started }));
  });
}

const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cwd: process.cwd(),
  port3016BusyBefore: await portBusy(3016),
  port3015BusyBefore: await portBusy(3015), // работещо dev демо в същата папка (за диагностика)
  phases: [],
};
if (summary.port3016BusyBefore) log.write("ВНИМАНИЕ: порт 3016 е зает преди старта — webServer ще се провали (reuseExistingServer=false).\n");

const build = await run("build", "npx", ["next", "build"]);
summary.phases.push(build);
if (build.code === 0) summary.phases.push(
    await run("playwright", "npx", ["playwright", "test", ...extraArgs], {
      LF_E2E_RUN_DIR: runDir,
      // Фалшиви тайни само за този пуск (T38): сървърът ги получава като VAPID_PRIVATE_KEY/SMTP_PASS и тестът проверява,
      // че не стигат до браузъра. Не са истински ключове; demo режимът не прави доставки.
      LF_E2E_FAKE_VAPID_PRIVATE: `e2eFakeVapid${randomBytes(16).toString("hex")}`,
      LF_E2E_FAKE_SMTP_PASS: `e2eFakeSmtp${randomBytes(16).toString("hex")}`,
    }),
  );
summary.finishedAt = new Date().toISOString();
summary.exitCode = summary.phases.find((p) => p.code !== 0)?.code ?? 0;
summary.failedPhase = summary.phases.find((p) => p.code !== 0)?.phase ?? null;
fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
log.end(`\n===== exit ${summary.exitCode}${summary.failedPhase ? ` (фаза: ${summary.failedPhase})` : ""} · логове: ${runDir}\n`);
console.log(`\n[e2e] exit ${summary.exitCode} · логове и артефакти: ${path.relative(process.cwd(), runDir)}`);
process.exit(summary.exitCode);
