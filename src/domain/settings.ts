import { z } from "zod";
import type { DbLike, Mode } from "@/lib/db";
import { CATEGORIES } from "./constants";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Формат ЧЧ:ММ");

export const packageSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  oneTimeCents: z.number().int().min(0).max(100_000_000),
  monthlyCents: z.number().int().min(0).max(10_000_000).nullable(),
});

export const settingsSchema = z
  .object({
    timezone: z.literal("Europe/Sofia"),
    dailyTarget: z.number().int().min(1).max(200),
    publishTime: hhmm,
    prepareTime: hhmm,
    activeWeekdays: z.array(z.number().int().min(1).max(7)).min(1),
    paused: z.boolean(),
    pauseNewLists: z.boolean(),
    reserveTarget: z.number().int().min(0).max(5000),
    priorityCities: z
      .array(z.object({ name: z.string().min(1).max(60), quota: z.number().int().min(0).max(200), enabled: z.boolean() }))
      .max(10),
    otherCities: z.array(z.string().min(1).max(60)).max(30),
    otherQuota: z.number().int().min(0).max(200),
    categories: z.array(z.object({ key: z.string(), label: z.string(), enabled: z.boolean() })).min(1),
    scoreWeights: z.object({
      noWebsite: z.number().int().min(-100).max(100),
      websiteIssues: z.number().int().min(-100).max(100),
      poorMobile: z.number().int().min(-100).max(100),
      goodReviews: z.number().int().min(-100).max(100),
      activeSocial: z.number().int().min(-100).max(100),
      verifiedPhone: z.number().int().min(-100).max(100),
      priorityCity: z.number().int().min(-100).max(100),
      strongModernSite: z.number().int().min(-100).max(100),
      bigChain: z.number().int().min(-100).max(100),
    }),
    callWindow: z.object({ start: hhmm, end: hhmm }),
    notifications: z.object({
      pushEnabled: z.boolean(),
      emailFallbackEnabled: z.boolean(),
      fallbackDelayMinutes: z.number().int().min(5).max(600),
    }),
    backlogWarningThreshold: z.number().int().min(5).max(1000),
    reserveFreshnessDays: z.number().int().min(1).max(365),
    retentionNotes: z.string().max(2000),
    packages: z.array(packageSchema).max(20),
    /**
     * Източник на НОВИТЕ дневни списъци. REAL = само реални (импортирани) записи — демо записите и
     * демо генераторът са изключени, без да се трие демо историята. Доставките на известия не зависят от това.
     */
    leadSource: z.enum(["DEMO", "REAL"]),
    /** „Не отговори“ → автоматично повторно обаждане след N работни дни (пн–пт, Europe/Sofia). */
    noAnswerRetryWorkdays: z.union([z.literal(2), z.literal(3)]),
    /** Начало на работния ден — час за автоматичните повторни обаждания. */
    workdayStart: hhmm,
  })
  .superRefine((s, ctx) => {
    if (s.prepareTime >= s.publishTime) {
      ctx.addIssue({ code: "custom", path: ["prepareTime"], message: "Подготовката трябва да е преди часа на публикуване." });
    }
  });

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Europe/Sofia",
  dailyTarget: 25,
  publishTime: "08:00",
  prepareTime: "07:00",
  activeWeekdays: [1, 2, 3, 4, 5], // нови списъци само понеделник–петък
  paused: false,
  pauseNewLists: false,
  reserveTarget: 100,
  priorityCities: [
    { name: "Варна", quota: 15, enabled: true },
    { name: "Плевен", quota: 5, enabled: true },
  ],
  otherCities: [],
  otherQuota: 5,
  categories: [
    { key: "restaurant", label: "Ресторанти/пицарии", enabled: true },
    { key: "auto", label: "Автосервизи/автоуслуги", enabled: true },
    { key: "beauty", label: "Салони за красота", enabled: true },
    { key: "home", label: "Строителни/домашни услуги", enabled: true },
    ...CATEGORIES.slice(4).map((c) => ({ key: c.key, label: c.label, enabled: true })),
  ],
  scoreWeights: {
    noWebsite: 30,
    websiteIssues: 20,
    poorMobile: 15,
    goodReviews: 15,
    activeSocial: 10,
    verifiedPhone: 10,
    priorityCity: 10,
    strongModernSite: -25,
    bigChain: -30,
  },
  callWindow: { start: "09:30", end: "18:00" },
  notifications: { pushEnabled: true, emailFallbackEnabled: true, fallbackDelayMinutes: 30 },
  backlogWarningThreshold: 40,
  reserveFreshnessDays: 30,
  retentionNotes: "Минимални служебни данни. DNC записите се пазят за постоянно потискане; преглед веднъж годишно.",
  // Примерни начални стойности — редактируеми; не са актуален ценоразпис.
  leadSource: "DEMO",
  noAnswerRetryWorkdays: 2,
  workdayStart: "08:00",
  packages: [
    { key: "site-basic", label: "Сайт визитка (примерна цена)", oneTimeCents: 45000, monthlyCents: 2500 },
    { key: "site-menu", label: "Сайт с дигитално меню (примерна цена)", oneTimeCents: 70000, monthlyCents: 3500 },
    { key: "booking", label: "Сайт + онлайн записване (примерна цена)", oneTimeCents: 95000, monthlyCents: 4500 },
    { key: "orders", label: "Онлайн поръчки/система (примерна цена)", oneTimeCents: 150000, monthlyCents: 6000 },
  ],
};

export async function getSettings(db: DbLike): Promise<Settings> {
  const row = await db.appSettings.findUnique({ where: { id: 1 } });
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsSchema.safeParse(withNewCategories({ ...DEFAULT_SETTINGS, ...JSON.parse(row.data) }));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** Категории, добавени след записа на настройките, се появяват (разрешени); съществуващите избори не се пипат. */
function withNewCategories<T extends { categories?: { key: string; label: string; enabled: boolean }[] }>(s: T): T {
  if (!Array.isArray(s.categories)) return s;
  const have = new Set(s.categories.map((c) => c.key));
  const add = CATEGORIES.filter((c) => !have.has(c.key)).map((c) => ({ key: c.key, label: c.label, enabled: true }));
  return add.length ? { ...s, categories: [...s.categories, ...add] } : s;
}

/** Режим на данните за подбора: real режим или реален източник в demo база → правилата за real (без demo записи). */
export function dataMode(mode: Mode, s: Pick<Settings, "leadSource">): Mode {
  return mode === "real" || s.leadSource === "REAL" ? "real" : "demo";
}

export async function saveSettings(db: DbLike, input: unknown): Promise<Settings> {
  const s = settingsSchema.parse(input);
  await db.appSettings.upsert({ where: { id: 1 }, create: { id: 1, data: JSON.stringify(s) }, update: { data: JSON.stringify(s) } });
  return s;
}

/** Всички разрешени градове (приоритетни + избрани други). Никакво скрито национално разширяване. */
export function allowedCities(s: Settings): string[] {
  return [...s.priorityCities.filter((c) => c.enabled).map((c) => c.name), ...s.otherCities];
}
