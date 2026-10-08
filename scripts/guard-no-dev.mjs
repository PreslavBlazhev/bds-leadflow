// Отказва production build / start / E2E, докато `next dev` за ТАЗИ папка работи.
// Причина (08.10.2026): build-ове и `next start` в същата `.next`, докато dev сървърът работи, оставиха
// dev кеша на Turbopack в повредено състояние → браузърът получаваше "HMR hash mismatch" и се
// презареждаше безкрайно (стотици пъти в минута), включително след рестарт на dev сървъра.
// Изход: спри `npm run dev` / `npm run dev:all` и пусни командата отново.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runningDevServer(cwd = process.cwd()) {
  const lock = path.join(cwd, ".next", "dev", "lock");
  if (!fs.existsSync(lock)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(lock, "utf8"));
    process.kill(info.pid, 0); // хвърля, ако процесът не съществува (остарял lock след срив)
    return info;
  } catch {
    return null;
  }
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dev = runningDevServer();
  if (dev && process.env.LF_ALLOW_BUILD_WITH_DEV !== "1") {
    console.error(
      `\n[guard] Отказ: в тази папка работи \`next dev\` (pid ${dev.pid}, ${dev.appUrl}).\n` +
        "        build/start/E2E споделят папката .next и могат да развалят dev сървъра\n" +
        "        (безкраен refresh в браузъра). Спри npm run dev:all и опитай отново.\n",
    );
    process.exit(1);
  }
}
