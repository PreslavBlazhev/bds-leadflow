// npm run test:pg — същите интеграционни тестове, но върху истински PostgreSQL (не SQLite).
// LF_TEST_PG_URL: admin адрес към DISPOSABLE сървър. По подразбиране — локалният от scripts/pg-local.mjs
// (стартирай с: npm run pg:local -- start). Docker вариант: docker compose -f docker-compose.test.yml up -d.
// Допълнителни аргументи се подават на vitest (напр. файл).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgUrl } from "./pg-local.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.LF_TEST_PG_URL || pgUrl("postgres");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const p = spawn(process.execPath, [vitest, "run", "--project", "integration", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, LF_TEST_PG_URL: url },
});
p.on("exit", (code) => process.exit(code ?? 1));
