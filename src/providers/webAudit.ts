import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Ограничена live проверка на публичен сайт (по подразбиране ИЗКЛЮЧЕНА: LIVE_WEB_AUDIT_ENABLED).
 * SSRF защита:
 *  - само http/https, портове 80/443, без credentials в URL;
 *  - DNS резолюция → всички адреси трябва да са публичен unicast (IPv4 и IPv6, вкл. IPv4-mapped);
 *  - връзката се прави към ВЕЧЕ проверения IP (pinned lookup) → защита от DNS rebinding;
 *  - всеки redirect се проверява наново, максимум 3;
 *  - timeout, лимит на размера, без cookies/credentials, без изпълнение на JavaScript.
 * Заключенията са само за началната страница; не измисляме Lighthouse/SEO резултати.
 */

export class SsrfError extends Error {}

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  return addr.range() === "unicast";
}

export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("Невалиден URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError(`Забранена схема ${u.protocol}`);
  if (u.username || u.password) throw new SsrfError("URL с credentials е забранен");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) throw new SsrfError(`Забранен порт ${port}`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new SsrfError("Забранен вътрешен хост");
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new SsrfError(`Забранен адрес ${host}`);
  return u;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });

export async function resolvePublic(host: string, resolve: Resolver = defaultResolver): Promise<{ address: string; family: number }> {
  const h = host.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(h)) {
    if (!isPublicAddress(h)) throw new SsrfError(`Забранен адрес ${h}`);
    return { address: h, family: h.includes(":") ? 6 : 4 };
  }
  const addrs = await resolve(h);
  if (addrs.length === 0) throw new SsrfError("DNS няма адреси");
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new SsrfError(`DNS сочи към непубличен адрес ${a.address}`);
  return addrs[0]!;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  https: boolean;
  body: string;
  truncated: boolean;
}

export async function safeFetch(raw: string, opts: { resolve?: Resolver; maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {}): Promise<FetchResult> {
  const maxBytes = opts.maxBytes ?? 512_000;
  let url = checkUrlShape(raw);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const pinned = await resolvePublic(url.hostname, opts.resolve);
    const lookup: LookupFunction = (_h, o, cb) => {
      if ((o as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    };
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; truncated: boolean }>((resolveP, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        url,
        { method: "GET", lookup, headers: { "user-agent": "BDS-LeadFlow-audit/0.1 (+owner tool)", accept: "text/html" }, timeout: opts.timeoutMs ?? 8000, agent: false },
        (r) => {
          let size = 0;
          let truncated = false;
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              truncated = true;
              r.destroy();
              return;
            }
            chunks.push(c);
          });
          r.on("close", () => resolveP({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString("utf8"), truncated }));
          r.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      url = checkUrlShape(new URL(res.headers.location, url).toString());
      continue;
    }
    return { finalUrl: url.toString(), status: res.status, https: url.protocol === "https:", body: res.body, truncated: res.truncated };
  }
  throw new SsrfError("Твърде много пренасочвания");
}

/** Базова проверка на началната страница с обяснение за всяко заключение. */
export function analyzeHomepage(r: FetchResult) {
  const issues: string[] = [];
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(r.body);
  const contactVisible = /href=["']tel:|href=["']mailto:|контакт|обадете|резерв/i.test(r.body);
  if (!r.https) issues.push("няма HTTPS (крайният адрес е http)");
  if (!hasViewport) issues.push("няма mobile viewport meta (не е пълно доказателство за лош UX)");
  if (!contactVisible) issues.push("не се вижда телефон/CTA в HTML на началната страница");
  return {
    https: r.https,
    hasViewport,
    contactVisible,
    issues,
    evidence: `HTTP ${r.status}, ${r.finalUrl}${r.truncated ? " (съдържанието е отрязано при лимита)" : ""}. Проверена е само началната страница.`,
  };
}
