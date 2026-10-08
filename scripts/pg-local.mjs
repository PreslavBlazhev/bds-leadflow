// Локален DISPOSABLE PostgreSQL за тестове и пробен пренос (без Docker и без глобална инсталация).
//   node scripts/pg-local.mjs start | stop | status | url [dbname] | destroy
// Бинарни файлове: PG_BIN (папка с pg_ctl/initdb/psql) или .tools/pgsql/bin (портативен zip, извън Git).
// Данни: tests/.tmp/pg-data (gitignored). Слуша САМО на 127.0.0.1:54315 (не конфликтува с 5432/други проекти).
// Потребителят и паролата са ТЕСТОВИ (същите като в docker-compose.test.yml) — само за локалната машина.
// С Docker вместо това: docker compose -f docker-compose.test.yml up -d (същият порт и credentials).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PG_PORT = Number(process.env.LF_PG_PORT ?? 54315);
export const PG_USER = "lf_test";
export const PG_PASSWORD = "lf_test_local_only";
const BIN = process.env.PG_BIN ?? path.join(root, ".tools", "pgsql", "bin");
const DATA = path.join(root, "tests", ".tmp", "pg-data");
const LOG = path.join(root, "tests", ".tmp", "pg-local.log");
const exe = (n) => path.join(BIN, process.platform === "win32" ? `${n}.exe` : n);

export const pgUrl = (db = "postgres") => `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${db}`;

function run(bin, args, opts = {}) {
  const r = spawnSync(exe(bin), args, { encoding: "utf8", env: { ...process.env, PGPASSWORD: PG_PASSWORD }, ...opts });
  if (r.error) throw new Error(`${bin}: ${r.error.message}. Задай PG_BIN или разархивирай PostgreSQL в .tools/pgsql.`);
  return r;
}

function running() {
  if (!fs.existsSync(DATA)) return false;
  return run("pg_ctl", ["status", "-D", DATA]).status === 0;
}

function start() {
  if (!fs.existsSync(path.join(DATA, "PG_VERSION"))) {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const pw = path.join(root, "tests", ".tmp", "pg-pw.txt");
    fs.writeFileSync(pw, PG_PASSWORD);
    const r = run("initdb", ["-D", DATA, "-U", PG_USER, "--pwfile", pw, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--no-instructions"]);
    fs.rmSync(pw, { force: true });
    if (r.status !== 0) throw new Error(`initdb: ${r.stderr || r.stdout}`);
    // Само localhost; без SSL (локален тест). TimeZone на сървъра — UTC (приложението не зависи от него).
    fs.appendFileSync(path.join(DATA, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${PG_PORT}\ntimezone = 'UTC'\nmax_connections = 200\nfsync = off\n`);
  }
  if (running()) return console.log(`[pg-local] вече работи на 127.0.0.1:${PG_PORT}`);
  // stdio "ignore": postmaster наследява дескрипторите; с pipe spawnSync би чакал безкрайно.
  const r = run("pg_ctl", ["start", "-D", DATA, "-l", LOG, "-w", "-t", "60"], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`pg_ctl start: ${r.stderr || r.stdout}\nЛог: ${LOG}`);
  console.log(`[pg-local] стартиран на 127.0.0.1:${PG_PORT} (данни: tests/.tmp/pg-data)`);
}

function stop() {
  if (!running()) return console.log("[pg-local] не работи");
  run("pg_ctl", ["stop", "-D", DATA, "-m", "fast", "-w"]);
  console.log("[pg-local] спрян");
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "start") start();
    else if (cmd === "stop") stop();
    else if (cmd === "status") console.log(running() ? `работи: ${pgUrl().replace(PG_PASSWORD, "***")}` : "не работи");
    else if (cmd === "url") console.log(pgUrl(arg ?? "postgres"));
    else if (cmd === "destroy") {
      stop();
      fs.rmSync(DATA, { recursive: true, force: true });
      console.log("[pg-local] тестовите данни са изтрити (tests/.tmp/pg-data)");
    } else {
      console.log("Употреба: node scripts/pg-local.mjs start|stop|status|url [db]|destroy");
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
