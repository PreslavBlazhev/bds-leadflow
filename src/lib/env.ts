import { z } from "zod";

/**
 * Env валидация. Fail-closed: невалидна/смесена конфигурация спира процеса,
 * вместо да работи тихо с грешна база или реални доставки в demo.
 * Тайните (VAPID_PRIVATE_KEY, SMTP_PASS, GOOGLE_PLACES_API_KEY) никога не се връщат към браузъра —
 * UI получава само configured/missing (виж providerStatus()).
 */
const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/** Явен gate: "true"/"false"; липсва → default според APP_ENV (local: включено, production: изключено). */
const gate = z.enum(["true", "false", "1", "0", ""]).optional();

/** Името на базата (SQLite файл или PostgreSQL database) — само то се проверява за demo/test, не паролата/хоста. */
export function databaseName(url: string): string {
  if (url.startsWith("file:")) return url.replace(/^file:/, "").split("?")[0]!.toLowerCase();
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")).toLowerCase();
  } catch {
    return "";
  }
}

const isPgUrl = (u: string) => /^postgres(ql)?:\/\//.test(u);

const schema = z
  .object({
    /** local = тази машина (SQLite или локален PostgreSQL). production = Render: изисква PostgreSQL, HTTPS, real. */
    APP_ENV: z.enum(["local", "production"]).default("local"),
    APP_MODE: z.enum(["demo", "real"]),
    DATABASE_URL: z.string().refine((u) => u.startsWith("file:") || isPgUrl(u), "DATABASE_URL трябва да е file:… (SQLite) или postgresql://…"),
    APP_BASE_URL: z.url().default("http://localhost:3015"),
    /** Допълнителни разрешени Origin стойности (CSV, точни https://host[:port]). Host header-ът НЕ се ползва в production. */
    ALLOWED_ORIGINS: optStr,
    /** Колко доверени reverse proxy-та добавят X-Forwarded-For (Render: 1). 0 = не се вярва на заглавката. */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
    /** Production gates (виж docs/CUTOVER-AND-ROLLBACK.md). В production по подразбиране са ИЗКЛЮЧЕНИ. */
    SCHEDULER_ENABLED: gate,
    DELIVERIES_ENABLED: gate,
    /** Heartbeat по-стар от това → owner вижда „worker не отговаря“. */
    WORKER_STALE_SECONDS: z.coerce.number().int().min(30).max(3600).default(180),
    /** Задава се от Render във всяка услуга. Използва се само като защита: в Render средата се изисква APP_ENV=production. */
    RENDER: optStr,
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
    WORKER_TICK_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: optStr,
    VAPID_PRIVATE_KEY: optStr,
    VAPID_SUBJECT: optStr,
    SMTP_HOST: optStr,
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_SECURE: bool,
    SMTP_USER: optStr,
    SMTP_PASS: optStr,
    SMTP_FROM: optStr,
    OWNER_NOTIFY_EMAIL: optStr,
    GOOGLE_PLACES_API_KEY: optStr,
    GOOGLE_PLACES_TERMS_CONFIRMED: bool,
    LIVE_DISCOVERY_ENABLED: bool,
    LIVE_WEB_AUDIT_ENABLED: bool,
    ALLOW_REAL_TEST_DELIVERY: bool,
    /** Push/имейл се изграждат напълно (VAPID подпис, криптиране, MIME), но НЕ се изпращат. Статус: simulated. */
    NOTIFY_DRY_RUN: bool,
    PLACES_MAX_DETAILS_PER_MONTH: z.coerce.number().int().min(0).max(100_000).default(900),
    PLACES_MAX_SEARCH_PER_MONTH: z.coerce.number().int().min(0).max(1_000_000).default(2000),
  })
  .superRefine((e, ctx) => {
    const name = databaseName(e.DATABASE_URL);
    if (e.APP_MODE === "demo" && !/demo|test/.test(name)) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "APP_MODE=demo изисква база с 'demo' или 'test' в името (отделна база)." });
    }
    if (e.APP_MODE === "real" && /demo|test/.test(name)) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "APP_MODE=real не може да използва demo/test база." });
    }
    if (isPgUrl(e.DATABASE_URL)) {
      const u = new URL(e.DATABASE_URL);
      // Без blanket изключване на проверката на сертификатите.
      if (/accept_invalid_certs/i.test(u.searchParams.get("sslaccept") ?? "")) {
        ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "sslaccept=accept_invalid_certs е забранено." });
      }
    }
    if (e.RENDER && e.APP_ENV !== "production") {
      ctx.addIssue({ code: "custom", path: ["APP_ENV"], message: "Процесът работи в Render (RENDER е зададена) — нужно е APP_ENV=production." });
    }
    if (e.APP_ENV === "production") {
      if (!isPgUrl(e.DATABASE_URL)) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "APP_ENV=production изисква PostgreSQL (postgresql://…). SQLite не се създава в production." });
      if (e.APP_MODE !== "real") ctx.addIssue({ code: "custom", path: ["APP_MODE"], message: "APP_ENV=production изисква APP_MODE=real." });
      const base = new URL(e.APP_BASE_URL);
      if (base.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
        ctx.addIssue({ code: "custom", path: ["APP_BASE_URL"], message: "APP_ENV=production изисква публичен https:// APP_BASE_URL (canonical адрес)." });
      }
      if (base.pathname !== "/" || base.search || base.hash) ctx.addIssue({ code: "custom", path: ["APP_BASE_URL"], message: "APP_BASE_URL е само origin (https://host), без път." });
      if (isPgUrl(e.DATABASE_URL)) {
        const host = new URL(e.DATABASE_URL).hostname;
        const external = host.includes(".") && !/^(localhost|127\.0\.0\.1)$/.test(host);
        if (external && new URL(e.DATABASE_URL).searchParams.get("sslmode") !== "require") {
          ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "Външен PostgreSQL адрес изисква ?sslmode=require (вътрешният Render URL е в частната мрежа)." });
        }
      }
    }
    for (const o of (e.ALLOWED_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      try {
        if (new URL(o).origin !== o) throw new Error();
      } catch {
        ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: `Невалиден origin: ${o.slice(0, 80)}` });
      }
    }
  });

export type Env = z.infer<typeof schema>;

const on = (v: string | undefined) => v === "true" || v === "1";

/**
 * Production gates. local: включени (поведението на локалната система не се променя; доставките остават
 * подчинени на APP_MODE — demo никога не праща). production: само изрично "true" след проверен cutover.
 */
export function schedulerEnabled(env: Env): boolean {
  return env.SCHEDULER_ENABLED === undefined || env.SCHEDULER_ENABLED === "" ? env.APP_ENV === "local" : on(env.SCHEDULER_ENABLED);
}
export function deliveriesEnabled(env: Env): boolean {
  return env.DELIVERIES_ENABLED === undefined || env.DELIVERIES_ENABLED === "" ? env.APP_ENV === "local" : on(env.DELIVERIES_ENABLED);
}

/** Разрешени Origin стойности: canonical APP_BASE_URL + ALLOWED_ORIGINS. */
export function allowedOrigins(env: Env): Set<string> {
  return new Set([new URL(env.APP_BASE_URL).origin, ...(env.ALLOWED_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)]);
}

/** Доверени proxy hops: production по подразбиране 1 (Render), local 0. */
export function proxyHops(env: Env): number {
  return env.TRUSTED_PROXY_HOPS ?? (env.APP_ENV === "production" ? 1 : 0);
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Невалидна конфигурация (.env): ${msg}`);
  }
  cached = parsed.data;
  return cached;
}

/** Само за тестове. */
export function resetEnvCache() {
  cached = null;
}

export type ProviderState = "WORKING_LOCAL" | "DEMO_SIMULATED" | "IMPLEMENTED_NOT_LIVE_VERIFIED" | "BLOCKED";

export interface ProviderStatus {
  key: string;
  label: string;
  state: ProviderState;
  configured: boolean;
  reason: string;
}

/** Статус на интеграциите без да издава стойности на тайни. */
export function providerStatus(env: Env = getEnv()): ProviderStatus[] {
  const demo = env.APP_MODE === "demo";
  const vapid = !!(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
  const smtp = !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM && env.OWNER_NOTIFY_EMAIL);
  const places = !!env.GOOGLE_PLACES_API_KEY;
  return [
    {
      key: "demo",
      label: "DemoProvider (синтетични кандидати)",
      state: demo ? "DEMO_SIMULATED" : "BLOCKED",
      configured: demo,
      reason: demo ? "Детерминирани измислени данни, без външни заявки." : "Забранен в real режим.",
    },
    {
      key: "csv",
      label: "CSV импорт (ръчен източник)",
      state: "WORKING_LOCAL",
      configured: true,
      reason: "Реален импорт с preview, provenance и дедупликация.",
    },
    {
      key: "google_places",
      label: "Google Places (read-through)",
      state: "BLOCKED",
      configured: places,
      reason: !places
        ? "Липсва GOOGLE_PLACES_API_KEY."
        : !env.GOOGLE_PLACES_TERMS_CONFIRMED
          ? "Ключът е зададен, но условията за ЕИП/CRM употреба не са потвърдени (GOOGLE_PLACES_TERMS_CONFIRMED)."
          : "Адаптерът не е проверен end-to-end; live discovery остава изключено.",
    },
    {
      key: "b2b",
      label: "Лицензиран B2B доставчик",
      state: "BLOCKED",
      configured: false,
      reason: "Само интерфейс. Не е избран доставчик/договор.",
    },
    {
      key: "web_audit",
      label: "Live проверка на сайтове",
      state: env.LIVE_WEB_AUDIT_ENABLED && !demo ? "IMPLEMENTED_NOT_LIVE_VERIFIED" : demo ? "DEMO_SIMULATED" : "BLOCKED",
      configured: env.LIVE_WEB_AUDIT_ENABLED,
      reason: demo ? "В демото се ползват синтетични доказателства." : env.LIVE_WEB_AUDIT_ENABLED ? "Включено, с SSRF защита; не е проверено с реални сайтове." : "Изключено по подразбиране (LIVE_WEB_AUDIT_ENABLED).",
    },
    {
      key: "push",
      label: "Web Push (VAPID)",
      state: demo ? "DEMO_SIMULATED" : vapid ? "IMPLEMENTED_NOT_LIVE_VERIFIED" : "BLOCKED",
      configured: vapid,
      reason: demo
        ? "DEMO_MODE: доставките са локални previews."
        : vapid
          ? "Ключовете са зададени; доставка до телефон не е проверена."
          : "Липсват VAPID ключове (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT).",
    },
    {
      key: "email",
      label: "Резервен имейл (SMTP)",
      state: demo ? "DEMO_SIMULATED" : smtp ? "IMPLEMENTED_NOT_LIVE_VERIFIED" : "BLOCKED",
      configured: smtp,
      reason: demo
        ? "DEMO_MODE: имейлът е само preview, не е изпратен."
        : smtp
          ? "SMTP е конфигуриран; реална доставка не е проверена."
          : "Липсват SMTP_HOST/SMTP_PORT/SMTP_FROM или OWNER_NOTIFY_EMAIL.",
    },
    {
      key: "ai",
      label: "AI предложения",
      state: "BLOCKED",
      configured: false,
      reason: "Не е включен. Използват се „Предложения по шаблон“.",
    },
  ];
}
