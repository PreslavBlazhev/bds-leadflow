import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { parse as parseDomain } from "tldts";

/**
 * Identity нормализация. Валиден формат ≠ действащ номер. Platform домейни (facebook.com и т.н.)
 * никога не са идентификатор на бизнес — много различни фирми споделят един и същ домейн.
 */

export type PhoneKind = "E164" | "DEMO_SYNTHETIC" | "INVALID";

export interface NormalizedPhone {
  raw: string;
  normalized: string | null;
  kind: PhoneKind;
}

const DEMO_PHONE_RE = /^DEMO-(\d{1,6})$/i;

/** Синтетичен demo namespace: "DEMO-0012". Не е диалируем и не минава през production валидатора. */
export function isDemoPhone(raw: string): boolean {
  return DEMO_PHONE_RE.test(raw.trim());
}

export function normalizePhone(raw: string | null | undefined): NormalizedPhone | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const demo = DEMO_PHONE_RE.exec(trimmed);
  if (demo) return { raw: trimmed, normalized: `DEMO-${demo[1]!.padStart(4, "0")}`, kind: "DEMO_SYNTHETIC" };
  // Excel понякога пази телефона с водещ апостроф; "00" международен префикс → "+".
  let s = trimmed.replace(/^'/, "").replace(/[\s().\-/]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  const parsed = parsePhoneNumberFromString(s, "BG");
  if (!parsed || !parsed.isValid()) return { raw: trimmed, normalized: null, kind: "INVALID" };
  return { raw: trimmed, normalized: parsed.number, kind: "E164" };
}

/** Маскиран display за demo номера — недиалируем. */
export function maskDemoPhone(normalized: string): string {
  const n = normalized.replace(/\D/g, "").slice(-3);
  return `+359 XX XXX X${n} (ДЕМО)`;
}

export function formatPhone(normalized: string | null, kind: string | null): string {
  if (!normalized) return "Няма телефон";
  if (kind === "DEMO_SYNTHETIC") return maskDemoPhone(normalized);
  const p = parsePhoneNumberFromString(normalized);
  return p ? p.formatInternational() : normalized;
}

/** Общи платформи — не идентифицират конкретен бизнес. */
export const PLATFORM_DOMAINS = new Set([
  "facebook.com",
  "fb.com",
  "instagram.com",
  "tiktok.com",
  "google.com",
  "goo.gl",
  "g.page",
  "linktr.ee",
  "youtube.com",
  "booking.com",
  "tripadvisor.com",
  "foursquare.com",
  "yelp.com",
  "glovoapp.com",
  "foodpanda.bg",
  "takeaway.com",
  "wolt.com",
  "bezplatno.net",
  "olx.bg",
  "example.invalid",
]);

export function safeHttpUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Регистриран домейн с public suffix логика (tldts, включително private PSL секцията —
 * "foo.github.io" остава различен от "bar.github.io"). Връща null за platform домейни.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  const url = safeHttpUrl(input);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  const info = parseDomain(host, { allowPrivateDomains: true });
  if (info.isIp) return null;
  const domain = info.domain;
  if (!domain) return null;
  // example.invalid: demo URL-и — уникални по поддомейн, не по регистриран домейн.
  if (host.endsWith(".example.invalid")) return host.replace(/^www\./, "");
  const icann = parseDomain(host).domain;
  if ((icann && PLATFORM_DOMAINS.has(icann)) || PLATFORM_DOMAINS.has(domain)) return null;
  return domain;
}

export function isPlatformUrl(input: string | null | undefined): boolean {
  const url = safeHttpUrl(input);
  if (!url) return false;
  const d = parseDomain(new URL(url).hostname).domain;
  return !!d && PLATFORM_DOMAINS.has(d);
}

// JS \b не работи с кирилица — суфиксите се махат на ниво токен.
const LEGAL_TOKENS = new Set(["еоод", "оод", "ет", "ад", "еад", "кд", "сд", "ltd", "eood", "ood", "llc"]);

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/["'„“”«»`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t && !LEGAL_TOKENS.has(t))
    .join(" ");
}

export function normalizeEik(eik: string | null | undefined): string | null {
  if (!eik) return null;
  const d = eik.replace(/\D/g, "");
  return /^(\d{9}|\d{13})$/.test(d) ? d : null;
}

export interface IdentityInput {
  name: string;
  city: string;
  phone?: string | null;
  website?: string | null;
  eik?: string | null;
  placeId?: string | null;
}

export interface IdentifierRow {
  type: "PHONE" | "DEMO_PHONE" | "DOMAIN" | "PLACE_ID" | "EIK" | "NAME_CITY";
  value: string;
  strong: boolean; // силен сигнал за една и съща идентичност
}

export function identifiersFor(input: IdentityInput): IdentifierRow[] {
  const out: IdentifierRow[] = [];
  const ph = normalizePhone(input.phone);
  if (ph?.normalized) out.push({ type: ph.kind === "DEMO_SYNTHETIC" ? "DEMO_PHONE" : "PHONE", value: ph.normalized, strong: true });
  const dom = normalizeDomain(input.website);
  if (dom) out.push({ type: "DOMAIN", value: dom, strong: true });
  const eik = normalizeEik(input.eik);
  if (eik) out.push({ type: "EIK", value: eik, strong: true });
  if (input.placeId) out.push({ type: "PLACE_ID", value: input.placeId, strong: true });
  const nn = normalizeName(input.name);
  if (nn) out.push({ type: "NAME_CITY", value: `${nn}|${normalizeName(input.city)}`, strong: false });
  return out;
}
