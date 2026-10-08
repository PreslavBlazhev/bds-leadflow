// npm run dev:all — стартира web (next dev) и worker в един терминал. Ctrl+C спира и двата безопасно.
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const procs = [
  ["web", ["run", "dev"]],
  ["worker", ["run", "worker:dev"]],
].map(([name, args]) => {
  const p = spawn(isWin ? "npm.cmd" : "npm", args, { stdio: ["ignore", "pipe", "pipe"], shell: isWin });
  const tag = (s) => s.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => {
    console.log(`[${name}] спря (код ${code})`);
    shutdown();
  });
  return p;
});

let down = false;
function shutdown() {
  if (down) return;
  down = true;
  for (const p of procs) {
    if (p.exitCode !== null) continue;
    if (isWin) spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
