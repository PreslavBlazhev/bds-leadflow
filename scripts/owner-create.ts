import readline from "node:readline";
import { scriptCtx, run } from "./_ctx";
import { hashPassword, validatePasswordStrength } from "../src/lib/auth";
import { audit } from "../src/lib/db";

/**
 * Интерактивно създаване на owner / смяна на паролата. Паролата не минава през аргументи,
 * shell история или логове. Без TTY се чете по ред от stdin (напр. от защитен файл).
 */
const lines: string[] = [];
let rl: readline.Interface | null = null;
let muted = false;

function iface() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  const orig = r._writeToOutput.bind(rl);
  r._writeToOutput = (s: string) => {
    if (muted && !s.includes(":")) r.output.write(s === "\r\n" || s === "\n" ? "\n" : "*");
    else orig(s);
  };
  rl.on("line", (l) => lines.push(l));
  return rl;
}

function ask(q: string, hidden = false): Promise<string> {
  const r = iface();
  return new Promise((resolve) => {
    muted = hidden;
    process.stdout.write(q);
    const done = () => {
      muted = false;
      if (hidden && process.stdin.isTTY) process.stdout.write("\n");
      resolve(lines.shift()!.trim());
    };
    if (lines.length) return done();
    r.once("line", () => setImmediate(done));
  });
}

run(async () => {
  const ctx = await scriptCtx("owner-create");
  const existing = await ctx.db.user.findFirst();
  if (existing) console.log(`Owner вече съществува (${existing.username}). Ще бъде сменена паролата.`);
  const username = existing?.username ?? ((await ask("Потребителско име: ")) || "owner");
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new Error("Невалидно име (3–40 символа: букви, цифри, . _ -).");
  const pw = await ask("Парола (мин. 12 символа): ", true);
  const weak = validatePasswordStrength(pw);
  if (weak) throw new Error(weak);
  const pw2 = await ask("Повтори паролата: ", true);
  if (pw !== pw2) throw new Error("Паролите не съвпадат.");
  rl?.close();
  const passwordHash = await hashPassword(pw);
  // Атомарно: новият хеш, обезсилването на ВСИЧКИ сесии и одитът — или всичко, или нищо.
  const revoked = await ctx.db.$transaction(async (t) => {
    await t.user.upsert({ where: { ownerSlot: 1 }, create: { username, passwordHash }, update: { passwordHash } });
    const r = await t.session.deleteMany({}); // смяна на парола → изход от всички устройства
    await audit(t, "cli", existing ? "owner.password_change" : "owner.create", "User", undefined, { username, revokedSessions: r.count });
    return r.count;
  });
  console.log(`Готово. Обезсилени сесии: ${revoked}. Влез на /login.`);
  await ctx.db.$disconnect();
});
