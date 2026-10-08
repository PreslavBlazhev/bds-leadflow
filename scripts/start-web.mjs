// Production start на web услугата (Render): next start на 0.0.0.0 и порта от PORT (Render го задава; default 10000).
// Не е next dev. Конфигурацията се валидира при старт (src/instrumentation.ts) — невалидна → изход 1.
// SIGTERM от Render се предава на next start (graceful shutdown на HTTP сървъра).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = String(Number(process.env.PORT ?? 10000) || 10000);
const host = process.env.HOST ?? "0.0.0.0";
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [next, "start", "-H", host, "-p", port], { stdio: "inherit", cwd: root, env: process.env });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
