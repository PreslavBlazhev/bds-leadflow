/**
 * Време и дати. Всички изчисления минават през IANA зоната Europe/Sofia чрез Intl —
 * без фиксиран UTC+2/UTC+3. DB пази UTC; дневните ключове са localDate "YYYY-MM-DD".
 */
export const TZ = "Europe/Sofia";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string | Date): Clock & { set(d: string | Date): void; advance(ms: number): void } {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = new Date(d).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1 = понеделник … 7 = неделя
}

export function localParts(d: Date): LocalParts {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) p[x.type] = x.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WD[p.weekday ?? "Mon"] ?? 1,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function localDateOf(d: Date): string {
  const p = localParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Отместване на Europe/Sofia спрямо UTC в минути за даден момент. */
export function offsetMinutes(d: Date): number {
  const p = localParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Местно време (localDate + "HH:mm") → UTC момент. Коректно около DST преходите. */
export function zonedToUtc(localDate: string, hhmm: string): Date {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const [hh, mi] = hhmm.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, d, hh, mi, 0);
  let guess = naive - offsetMinutes(new Date(naive)) * 60000;
  guess = naive - offsetMinutes(new Date(guess)) * 60000;
  return new Date(guess);
}

export function addDays(localDate: string, n: number): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function weekdayOf(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function isLocalDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** dd.MM.yyyy */
export function fmtDate(input: Date | string | null | undefined): string {
  if (!input) return "—";
  if (typeof input === "string" && isLocalDate(input)) {
    const [y, m, d] = input.split("-");
    return `${d}.${m}.${y}`;
  }
  const p = localParts(new Date(input));
  return `${pad(p.day)}.${pad(p.month)}.${p.year}`;
}

/** dd.MM.yyyy HH:mm (24ч, българско време) */
export function fmtDateTime(input: Date | string | null | undefined): string {
  if (!input) return "—";
  const p = localParts(new Date(input));
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function fmtTime(input: Date | string): string {
  const p = localParts(new Date(input));
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DDTHH:mm" за <input type=datetime-local> в българско време. */
export function toLocalInput(d: Date): string {
  const p = localParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Обратното на toLocalInput: интерпретира стойността като Europe/Sofia. */
export function fromLocalInput(v: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v);
  if (!m) throw new Error("Невалидна дата/час");
  return zonedToUtc(m[1]!, m[2]!);
}

export const WEEKDAY_LABELS = ["Пон", "Вт", "Ср", "Чет", "Пет", "Съб", "Нед"];
