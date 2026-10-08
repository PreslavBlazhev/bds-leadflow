import type { DbLike } from "@/lib/db";
import { addDays, localDateOf, zonedToUtc } from "@/lib/time";
import { backlogItems } from "./batch";
import { CONTACT_ACTIVITY_TYPES } from "./constants";
import { getSettings } from "./settings";
import { activeList } from "./activeList";

/**
 * Три отделни опашки за обаждания (досега бяха смесени в една: нови + последващи + необработени).
 *  - new:       само днешните нови контакти без записан контакт; поредността е тази на списъка.
 *  - followups: бизнеси с отворено последващо обаждане за днес или просрочено (без задачите за оферти).
 *  - backlog:   издадени в предишни дни, но без нито един записан контакт („необработени контакти“).
 * Всеки бизнес е най-много веднъж в дадена опашка. Старите контакти никога не влизат в „Нови днес“.
 */
export const QUEUE_KEYS = ["new", "followups", "backlog"] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

export const QUEUE_LABELS: Record<QueueKey, string> = {
  new: "Активен списък",
  followups: "За повторно обаждане",
  backlog: "Необработени от предишни дни",
};

export interface QueueEntry {
  businessId: string;
  note: string; // кратко пояснение защо е в опашката
}

export interface CallQueues {
  today: string;
  queues: Record<QueueKey, QueueEntry[]>;
  /** Днешният списък: колко нови са издадени и колко вече имат записан резултат. */
  newProgress: { total: number; done: number };
}

/**
 * Реален режим: „Активен списък“ = всички контакти от неприключения списък без записан резултат — и когато
 * списъкът е от предишна дата (смяна на деня, рестарт и уикенд не го приключват). Отделна опашка „необработени“ няма.
 */
async function realQueues(db: DbLike, today: string, startToday: Date, endToday: Date, notDemo: { isDemo?: boolean }): Promise<CallQueues> {
  const a = await activeList(db, { realOnly: true });
  const newQ: QueueEntry[] = a.pending.map((p) => {
    const [y, m, d] = p.localDate.split("-");
    return { businessId: p.businessId, note: `${p.localDate === today ? "Днешен списък" : `Активен списък от ${d}.${m}.${y}`} · №${p.position}` };
  });
  const followups = await followupQueue(db, startToday, endToday, notDemo);
  return { today, queues: { new: newQ, followups, backlog: [] }, newProgress: { total: a.total, done: a.handled } };
}

async function followupQueue(db: DbLike, startToday: Date, endToday: Date, notDemo: { isDemo?: boolean }): Promise<QueueEntry[]> {
  const fus = await db.followUp.findMany({
    where: { status: "OPEN", dueAt: { lt: endToday }, kind: { not: "OFFER" }, business: { ...notDemo, mergedIntoId: null, suppressions: { none: { liftedAt: null, type: "DNC" } } } },
    orderBy: { dueAt: "asc" },
    select: { businessId: true, dueAt: true, reason: true },
  });
  const out: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const f of fus) {
    if (seen.has(f.businessId)) continue; // няколко задачи за един бизнес → един ред
    seen.add(f.businessId);
    const overdue = f.dueAt < startToday;
    const p = new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(f.dueAt);
    out.push({ businessId: f.businessId, note: `${overdue ? "Просрочено" : "Днес"} · ${p} · ${f.reason}` });
  }
  return out;
}

export async function buildCallQueues(db: DbLike, now: Date): Promise<CallQueues> {
  const today = localDateOf(now);
  const startToday = zonedToUtc(today, "00:00");
  const endToday = zonedToUtc(addDays(today, 1), "00:00");
  // Реален източник: демо контактите (вкл. днешен демо списък, публикуван преди превключването) не влизат в опашките.
  const meta = await db.systemMeta.findUnique({ where: { id: 1 }, select: { mode: true } });
  const realOnly = (await getSettings(db)).leadSource === "REAL" || meta?.mode === "real";
  const notDemo = realOnly ? { isDemo: false } : {};
  if (realOnly) return realQueues(db, today, startToday, endToday, notDemo);

  const batch = await db.dailyBatch.findUnique({
    where: { localDate: today },
    include: {
      items: {
        orderBy: { position: "asc" },
        select: {
          businessId: true,
          position: true,
          business: { select: { isDemo: true, _count: { select: { activities: { where: { type: { in: CONTACT_ACTIVITY_TYPES } } } } }, suppressions: { where: { liftedAt: null, type: "DNC" }, select: { id: true } } } },
        },
      },
    },
  });
  const items = batch?.items ?? [];
  const newQ: QueueEntry[] = [];
  let done = 0;
  for (const it of items) {
    if (realOnly && it.business.isDemo) continue;
    const contacted = it.business._count.activities > 0 || it.business.suppressions.length > 0;
    if (contacted) done++;
    else newQ.push({ businessId: it.businessId, note: `Нов днес · №${it.position}` });
  }

  const followQ = await followupQueue(db, startToday, endToday, notDemo);

  const back = await backlogItems(db, today, { realOnly });
  const backQ: QueueEntry[] = [];
  const seenB = new Set<string>();
  for (const b of back) {
    if (seenB.has(b.businessId)) continue;
    seenB.add(b.businessId);
    const [y, m, d] = b.batch.localDate.split("-");
    backQ.push({ businessId: b.businessId, note: `Издаден на ${d}.${m}.${y} · без записан резултат` });
  }
  return { today, queues: { new: newQ, followups: followQ, backlog: backQ }, newProgress: { total: items.length - (realOnly ? items.filter((i) => i.business.isDemo).length : 0), done } };
}
