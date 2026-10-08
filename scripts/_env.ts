import fs from "node:fs";
import path from "node:path";

/** Минимален .env loader (Node 21.5 няма process.loadEnvFile). Не презаписва вече зададени променливи. */
/** Файлът се избира с LEADFLOW_ENV_FILE (напр. .env.real); по подразбиране .env (demo). */
export function envFilePath(): string {
  return path.resolve(process.cwd(), process.env.LEADFLOW_ENV_FILE || ".env");
}

export function loadDotEnv(file = envFilePath()): boolean {
  if (!fs.existsSync(file)) return false;
  const override = path.basename(file) !== ".env";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // Изрично избран файл (напр. .env.real) има приоритет: @prisma/client при import сам зарежда .env (demo)
    // и иначе real режимът тихо би наследил demo стойности. Стандартният .env не презаписва вече зададени.
    if (override || process.env[m[1]!] === undefined) process.env[m[1]!] = v;
  }
  return true;
}
