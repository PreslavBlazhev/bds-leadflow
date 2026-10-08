// Генерира prisma/postgresql/schema.prisma от prisma/schema.prisma (единственият източник на моделите).
//   node scripts/prisma-pg-schema.mjs          → записва файла
//   node scripts/prisma-pg-schema.mjs --check  → exit 1, ако записаният файл се различава (CI / преди commit)
// Сменят се САМО generator и datasource блоковете. Моделите, полетата, връзките, @unique/@@unique/@@index
// остават байт по байт същите, затова двата клиента имат идентичен TypeScript API.
// Частичните индекси (WHERE …), които Prisma не изразява, са в миграционните SQL файлове на двата provider-а.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "prisma", "schema.prisma");
const OUT = path.join(root, "prisma", "postgresql", "schema.prisma");

const HEADER = `// ГЕНЕРИРАН ФАЙЛ — не редактирай. Източник: prisma/schema.prisma; команда: npm run db:pg:schema
// PostgreSQL схема за production. Миграции: prisma/postgresql/migrations (отделна история от SQLite).
`;

const GENERATOR = `generator client {
  provider      = "prisma-client-js"
  // Отделен клиент за PostgreSQL; зарежда се по време на изпълнение от src/lib/prismaClients.ts.
  output        = "../../node_modules/.prisma-pg/client"
  binaryTargets = ["native"]
}`;

const DATASOURCE = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;

export function buildPgSchema(src) {
  const gen = /generator client \{[^}]*\}/;
  const ds = /datasource db \{[^}]*\}/;
  if (!gen.test(src) || !ds.test(src)) throw new Error("prisma/schema.prisma: липсва generator client или datasource db блок");
  if (!/provider\s*=\s*"sqlite"/.test(src.match(ds)[0])) throw new Error("prisma/schema.prisma трябва да е SQLite източникът");
  // Заглавните коментари преди първия блок се заменят с генерирания header.
  const body = src.slice(src.search(gen)).replace(gen, GENERATOR).replace(ds, DATASOURCE);
  return HEADER + "\n" + body;
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const want = buildPgSchema(fs.readFileSync(SRC, "utf8")).replace(/\r\n/g, "\n");
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (have !== want) {
      console.error("[pg-schema] prisma/postgresql/schema.prisma не съвпада с prisma/schema.prisma. Изпълни: npm run db:pg:schema");
      process.exit(1);
    }
    console.log("[pg-schema] OK — PostgreSQL схемата съвпада с източника.");
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, want);
    console.log(`[pg-schema] записан ${path.relative(root, OUT)}`);
  }
}
