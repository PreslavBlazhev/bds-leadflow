import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishDailyBatch } from "@/domain/batch";
import { buildEligibilityCtx, candidateInclude, evaluateEligibility, type CandidateRow } from "@/domain/eligibility";
import { liftDnc, recordOutcome } from "@/domain/outcomes";
import { processOutbox } from "@/domain/notifications";
import { getSettings } from "@/domain/settings";
import { createSession, hashPassword, sessionUser, verifyPassword } from "@/lib/auth";
import { zonedToUtc } from "@/lib/time";
import { addLead, addLeads, closeDb, testDb, type TestCtx } from "./helpers";

let ctx: TestCtx;
afterEach(async () => ctx && closeDb(ctx));

const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");


function runNode(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [TSX, ...args], { env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    p.stdin.end(opts.input ?? "");
  });
}

async function eligible(c: TestCtx, id: string) {
  const e = await buildEligibilityCtx(c.db, c.mode, await getSettings(c.db), c.clock.now());
  const b = (await c.db.business.findUniqueOrThrow({ where: { id }, include: candidateInclude })) as CandidateRow;
  return evaluateEligibility(b, e);
}

describe("паралелно генериране от ОТДЕЛНИ процеси", () => {
  it("T05+ 4 Node процеса публикуват едновременно → 1 batch, 25 уникални, един created", async () => {
    ctx = await testDb();
    await addLeads(ctx, 60, { city: "Варна" });
    await addLeads(ctx, 30, { city: "Плевен" });
    const iso = ctx.clock.now().toISOString();
    const res = await Promise.all(Array.from({ length: 4 }, () => runNode([path.resolve("tests/integration/fixtures/publish-child.ts"), ctx.url, iso])));
    for (const r of res) expect(r.code, r.err).toBe(0);
    const parsed = res.map((r) => JSON.parse(r.out) as { batchId: string; created: boolean; total: number });
    expect(new Set(parsed.map((p) => p.batchId)).size).toBe(1);
    expect(parsed.filter((p) => p.created)).toHaveLength(1);
    expect(parsed.every((p) => p.total === 25)).toBe(true);
    expect(await ctx.db.dailyBatch.count()).toBe(1);
    const items = await ctx.db.dailyBatchItem.findMany();
    expect(items).toHaveLength(25);
    expect(new Set(items.map((i) => i.businessId)).size).toBe(25);
    expect(await ctx.db.notificationOutbox.count()).toBe(2); // един push + един fallback, не по един на процес
  }, 120_000);
});

describe("DNC", () => {
  it("премахнат DNC не прави записа нов; audit с причина; друг запис със същия телефон остава изключен", async () => {
    ctx = await testDb();
    const a = await addLead(ctx, { name: "ТЕСТ DNC Основен", phone: "0887000001" });
    await recordOutcome(ctx, { businessId: a.businessId, outcome: "DO_NOT_CONTACT", callConnected: true, idempotencyKey: "idem-dnc-lift-1" });
    // нов запис с друго име, но същия телефон → изключен (потиснат идентификатор + review)
    const b = await addLead(ctx, { name: "ТЕСТ Съвсем Друго Име", phone: "+359 887 000 001" });
    const eb = await eligible(ctx, b.businessId);
    expect(eb.eligible).toBe(false);
    expect(eb.reasons.join(" ")).toMatch(/потискане|DNC|дубликат|Споделен/);
    await expect(liftDnc(ctx, a.businessId, "x")).rejects.toThrow(/причина/);
    await liftDnc(ctx, a.businessId, "Поиска сам да се свържем отново");
    expect(await ctx.db.auditLog.count({ where: { action: "dnc.lift" } })).toBe(1);
    const ea = await eligible(ctx, a.businessId);
    expect(ea.eligible).toBe(false); // история на контакт остава
    const r = await publishDailyBatch(ctx, { trigger: "manual" });
    const ids = (await ctx.db.dailyBatchItem.findMany({ where: { batchId: r.batchId } })).map((i) => i.businessId);
    expect(ids).not.toContain(a.businessId);
    expect(ids).not.toContain(b.businessId);
  });
});

describe("резервен имейл — време при закъсняло публикуване", () => {
  it("notBefore = 30 мин след по-късното от scheduledAt и publishedAt; не се изпраща по-рано", async () => {
    ctx = await testDb({ mode: "real", now: "2026-10-07T06:40:00Z" }); // 09:40 местно — закъсняло
    await addLeads(ctx, 30);
    const biz = await ctx.db.business.findMany();
    for (const [i, x] of biz.entries()) await ctx.db.business.update({ where: { id: x.id }, data: { phoneNormalized: `+3598830${String(i).padStart(5, "0")}`, phoneKind: "E164", isDemo: false } });
    const r = await publishDailyBatch(ctx, { trigger: "scheduler", late: true });
    const email = await ctx.db.notificationOutbox.findUniqueOrThrow({ where: { dedupeKey: `email:fallback:${r.localDate}` } });
    expect(email.notBefore.toISOString()).toBe("2026-10-07T07:10:00.000Z");
    expect(zonedToUtc(r.localDate, "08:00").getTime() + 30 * 60_000).toBeLessThan(email.notBefore.getTime());
    await ctx.db.pushSubscription.create({ data: { endpoint: "https://push.example.invalid/x", p256dh: "p".repeat(20), auth: "a".repeat(12) } });
    const sent: string[] = [];
    const tr = { push: { send: async () => ({ ok: true as const, statusCode: 201 }) }, email: { send: async (m: { idempotencyKey: string }) => (sent.push(m.idempotencyKey), { ok: true as const, messageId: "x" }) }, baseUrl: "http://localhost:3015" };
    ctx.clock.set("2026-10-07T07:09:00Z");
    await processOutbox(ctx, tr);
    expect(sent).toHaveLength(0);
    ctx.clock.set("2026-10-07T07:10:30Z");
    await processOutbox(ctx, tr);
    expect(sent).toEqual([`email:fallback:${r.localDate}`]);
  });
});

describe("owner:create (истинският CLI скрипт срещу временна база)", () => {
  it("смяна на паролата е атомарна, обезсилва всички сесии и не издава паролата; слаба/несъвпадаща парола не променя нищо", async () => {
    ctx = await testDb();
    const env = { APP_MODE: "demo", DATABASE_URL: ctx.url };
    const script = path.resolve("scripts/owner-create.ts");
    const oldPw = "Old-Passw0rd-xyz";
    const newPw = "New-Passw0rd-abc";
    const created = await runNode([script], { env, input: `owner\n${oldPw}\n${oldPw}\n` });
    expect(created.code, created.err).toBe(0);
    expect(created.out + created.err).not.toContain(oldPw);
    const u = await ctx.db.user.findUniqueOrThrow({ where: { ownerSlot: 1 } });
    expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
    const s1 = await createSession(ctx.db, u.id, 24);
    const s2 = await createSession(ctx.db, u.id, 24);
    expect(await sessionUser(ctx.db, s1.token)).not.toBeNull();

    // слаба парола → отказ, нищо не се променя
    const weak = await runNode([script], { env, input: "short\nshort\n" });
    expect(weak.code).not.toBe(0);
    // несъвпадение → отказ
    const mismatch = await runNode([script], { env, input: `${newPw}\n${newPw}-different\n` });
    expect(mismatch.code).not.toBe(0);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { ownerSlot: 1 } })).passwordHash).toBe(u.passwordHash);
    expect(await sessionUser(ctx.db, s2.token)).not.toBeNull();

    // успешна смяна (съществуващ owner — не пита за име)
    const changed = await runNode([script], { env, input: `${newPw}\n${newPw}\n` });
    expect(changed.code, changed.err).toBe(0);
    expect(changed.out).toMatch(/Обезсилени сесии: 2/);
    expect(changed.out + changed.err).not.toContain(newPw);
    const after = await ctx.db.user.findUniqueOrThrow({ where: { ownerSlot: 1 } });
    expect(after.username).toBe("owner");
    expect(await verifyPassword(after.passwordHash, oldPw)).toBe(false);
    expect(await verifyPassword(after.passwordHash, newPw)).toBe(true);
    expect(await sessionUser(ctx.db, s1.token)).toBeNull();
    expect(await sessionUser(ctx.db, s2.token)).toBeNull();
    expect(await ctx.db.session.count()).toBe(0);
    expect(await ctx.db.user.count()).toBe(1);
    const audits = await ctx.db.auditLog.findMany({ where: { action: { in: ["owner.create", "owner.password_change"] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(["owner.create", "owner.password_change"]);
    expect(JSON.stringify(audits)).not.toContain(newPw);
    void hashPassword; // хеширането е през @node-rs/argon2 (Argon2id)
  }, 120_000);
});
