import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { PrismaClient } from "@prisma/client";

/**
 * Един owner. Пароли: Argon2id (@node-rs/argon2). Сесии: 256-bit случаен token в HttpOnly cookie,
 * в DB се пази само sha256(token). Без собствена криптография.
 */
export const SESSION_COOKIE = "lf_session";

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hashStr: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 12) return "Паролата трябва да е поне 12 символа.";
  if (/^(.)\1+$/.test(pw)) return "Паролата е твърде проста.";
  if (["admin", "password", "123456", "qwerty"].some((w) => pw.toLowerCase().includes(w))) return "Паролата съдържа често срещана дума.";
  return null;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(db: PrismaClient, userId: string, ttlHours: number, userAgent?: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.session.create({ data: { id: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) } });
  return { token, expiresAt };
}

export async function sessionUser(db: PrismaClient, token: string | undefined) {
  if (!token || token.length > 100) return null;
  const s = await db.session.findUnique({ where: { id: sha256(token) }, include: { user: { select: { id: true, username: true } } } });
  if (!s) return null;
  if (s.expiresAt < new Date()) {
    await db.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }
  return { sessionId: s.id, user: s.user };
}

export async function destroySession(db: PrismaClient, token: string | undefined) {
  if (!token) return;
  await db.session.deleteMany({ where: { id: sha256(token) } });
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;

/** Rate limit: максимум 5 неуспешни опита за 15 мин по потребител и по IP. */
export async function loginBlocked(db: PrismaClient, keys: string[]): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  for (const key of keys) {
    const fails = await db.loginAttempt.count({ where: { key, success: false, at: { gte: since } } });
    if (fails >= MAX_FAILS) return true;
  }
  return false;
}

export async function recordLogin(db: PrismaClient, keys: string[], success: boolean) {
  for (const key of keys) await db.loginAttempt.create({ data: { key, success } });
  if (success) await db.loginAttempt.deleteMany({ where: { key: { in: keys }, success: false } });
}
