import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { adminExec, assertSafePgTestUrl, dbUrl, isPgTest, templateName } from "./pgTest";

/**
 * Една мигрирана template база; всеки тестов файл работи върху собствено копие (без мрежа, без demo.db).
 * SQLite (по подразбиране): tests/.tmp/template-test.db. PostgreSQL (LF_TEST_PG_URL): база lf_template_test.
 */
export default async function setup() {
  const dir = path.resolve("tests/.tmp");
  fs.mkdirSync(dir, { recursive: true });
  if (isPgTest) {
    assertSafePgTestUrl();
    const tpl = templateName();
    await adminExec(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
    await adminExec(`CREATE DATABASE "${tpl}" TEMPLATE template0 ENCODING 'UTF8'`);
    execFileSync(process.execPath, [path.resolve("scripts/prisma-pg.mjs"), "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl(tpl) }, stdio: "pipe" });
    return async () => {
      await adminExec(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
    };
  }
  for (const f of fs.readdirSync(dir)) if (/\.db(-wal|-shm|-journal)?$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, "template-test.db");
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${file.split(path.sep).join("/")}` },
    stdio: "pipe",
  });
  process.env.LF_TEMPLATE_DB = file;
}
