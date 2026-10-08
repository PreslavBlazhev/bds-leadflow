"use client";

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status: number;
}

/** JSON заявка към собствения backend. Браузърът добавя Origin → минава CSRF проверката. */
export async function callApi<T = unknown>(url: string, body?: unknown, method = "POST"): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.status === 401) {
      // Пълно презареждане към login (изчиства клиентското състояние след изтекла сесия).
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return { ok: false, status: 401, error: "Нужен е вход." };
    }
    const j = (await res.json().catch(() => ({}))) as { error?: string } & T;
    return res.ok ? { ok: true, data: j, status: res.status } : { ok: false, error: j.error ?? `Грешка ${res.status}`, status: res.status };
  } catch {
    return { ok: false, status: 0, error: "Няма връзка със сървъра." };
  }
}

export function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
