import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { convertPilot, pilotLiveView, reviewPilot, type convertInput, type reviewInput } from "@/domain/pilot";
import { jsonBody } from "@/lib/body";
import { getEnv } from "@/lib/env";
import { api } from "@/lib/server";
import { createPlacesClient, PlacesBlockedError, PlacesBudgetError } from "@/providers/googlePlaces";

/**
 * load    — живи данни от Google за преглед (не се записват; брои се в месечния лимит).
 * review  — одобри / отхвърли / върни за преглед.
 * convert — след разговор: мой CRM запис с данни, потвърдени от бизнеса.
 */
export const POST = api(async (ctx, req, p) => {
  if (ctx.mode !== "real") throw new DomainError("FORBIDDEN", "Пилотът работи само в real режим (отделната реална база).");
  const b = await jsonBody(req);
  if (p.action === "load") {
    const { id } = z.object({ id: z.string() }).parse(b);
    try {
      return await pilotLiveView(ctx, createPlacesClient(ctx.db, getEnv(), () => ctx.clock.now()), id);
    } catch (e) {
      if (e instanceof PlacesBlockedError || e instanceof PlacesBudgetError) throw new DomainError("BLOCKED", e.message);
      throw e;
    }
  }
  if (p.action === "review") return reviewPilot(ctx, b as z.input<typeof reviewInput>);
  if (p.action === "convert") return convertPilot(ctx, b as z.input<typeof convertInput>);
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});
