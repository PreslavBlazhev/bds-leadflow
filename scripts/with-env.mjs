// node scripts/with-env.mjs .env.real <команда...>
// Пуска команда с избран env файл: задава LEADFLOW_ENV_FILE (за scripts/*) и подава стойностите на файла
// като process env (Next.js ги предпочита пред .env). Така real режимът не наследява demo стойности.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const [file, ...cmd] = process.argv.slice(2);
if (process.argv[1] && path.basename(process.argv[1]) === "with-env.mjs") {
  if (!file || !cmd.length) {
    console.error("Употреба: node scripts/with-env.mjs <env файл> <команда>");
    process.exit(2);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`Липсва ${file}. За real режим първо: npm run real:init`);
    process.exit(1);
  }
  const env = { ...process.env, ...readEnvFile(abs), LEADFLOW_ENV_FILE: file };
  const p = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", shell: process.platform === "win32", env });
  p.on("exit", (code) => process.exit(code ?? 1));
}
