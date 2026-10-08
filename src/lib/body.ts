import type { NextRequest } from "next/server";
import { fromLocalInput } from "./time";
import { DomainError } from "@/domain/errors";

/** JSON body с лимит на размера. */
export async function jsonBody(req: NextRequest, maxBytes = 3_000_000): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new DomainError("VALIDATION", "Заявката е твърде голяма.");
  const text = await req.text();
  if (text.length > maxBytes) throw new DomainError("VALIDATION", "Заявката е твърде голяма.");
  if (!text) return {};
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new DomainError("VALIDATION", "Очакван е JSON обект.");
  return v as Record<string, unknown>;
}

/** Полета "...Local" (datetime-local от браузъра) → UTC Date, интерпретирани като Europe/Sofia. */
export function convertLocalDates(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(b)) {
    if (k.endsWith("AtLocal")) {
      delete out[k];
      if (typeof v === "string" && v) {
        try {
          out[k.replace(/Local$/, "")] = fromLocalInput(v);
        } catch {
          throw new DomainError("VALIDATION", "Невалидна дата/час.");
        }
      }
    }
  }
  return out;
}
