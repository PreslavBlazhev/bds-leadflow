import { allowedOrigins, getEnv, proxyHops, type Env } from "./env";

/**
 * CSRF: за cookie-auth мутации Origin трябва да е изрично разрешен (APP_BASE_URL + ALLOWED_ORIGINS).
 * Само локално (APP_ENV=local) се допуска и собственият Host (localhost/127.0.0.1 на различни портове при тестове);
 * в production Host header-ът не се използва за доверени адреси.
 */
export function originAllowed(req: Request, env: Env = getEnv()): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const allowed = allowedOrigins(env);
  const host = req.headers.get("host");
  if (host && env.APP_ENV === "local") {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return allowed.has(origin);
}

/**
 * IP за rate limit. X-Forwarded-For се взема само от доверените proxy hops (отдясно наляво), защото
 * левите стойности се подават от клиента. Без доверен proxy → "local". Лимитът по потребител остава отделно.
 */
export function clientIpFrom(h: Headers, env: Env = getEnv()): string {
  const hops = proxyHops(env);
  if (hops === 0) return "local";
  const parts = (h.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return (parts[parts.length - hops] ?? parts[0] ?? "unknown").slice(0, 60);
}
