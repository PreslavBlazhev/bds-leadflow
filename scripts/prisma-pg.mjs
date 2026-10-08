// Prisma CLI за PostgreSQL схемата: node scripts/prisma-pg.mjs <prisma команда…>
//   generate / validate  → не се свързва с база. Ако DATABASE_URL не е PostgreSQL (напр. локалният SQLite .env),
//                           подава се неизползваем placeholder само за валидацията на schema файла.
//   migrate deploy|status → ИЗИСКВА DATABASE_URL=postgresql://…; никога migrate dev/reset (отказва се).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(root, "prisma", "postgresql", "schema.prisma");
const args = process.argv.slice(2);
const cmd = args.join(" ");

if (/^migrate (dev|reset)\b/.test(cmd) || /^db (push|execute)\b/.test(cmd)) {
  console.error(`[prisma-pg] Отказ: „prisma ${cmd}“ не се използва за PostgreSQL базите на проекта. Нови миграции: виж docs/DATABASE-MIGRATION.md.`);
  process.exit(2);
}

const isPg = (u) => /^postgres(ql)?:\/\//.test(u ?? "");
const env = { ...process.env };
if (/^(generate|validate|format)\b/.test(cmd)) {
  if (!isPg(env.DATABASE_URL)) env.DATABASE_URL = "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder_not_used";
} else if (!isPg(env.DATABASE_URL)) {
  console.error("[prisma-pg] DATABASE_URL трябва да е postgresql://… за тази команда.");
  process.exit(2);
}

const bin = path.join(root, "node_modules", "prisma", "build", "index.js");
const r = spawnSync(process.execPath, [bin, ...args, "--schema", SCHEMA], { stdio: "inherit", env, cwd: root });
process.exit(r.status ?? 1);
