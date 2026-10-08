import { z } from "zod";
import { addActivity, archiveLead, confirmHistory, editLead, mergeBusinesses, resolveDistinct } from "@/domain/crm";
import { DomainError } from "@/domain/errors";
import { liftDnc, recordDialIntent } from "@/domain/outcomes";
import { convertLocalDates, jsonBody } from "@/lib/body";
import { api } from "@/lib/server";

const reason = z.object({ reason: z.string().max(500).default("") });

export const POST = api(async (ctx, req, p) => {
  const id = p.id!;
  const b = convertLocalDates(await jsonBody(req));
  switch (p.action) {
    case "edit":
      return editLead(ctx, id, b);
    case "archive":
      return archiveLead(ctx, id, reason.parse(b).reason, false);
    case "restore":
      return archiveLead(ctx, id, reason.parse(b).reason, true);
    case "history": {
      const v = z.object({ state: z.enum(["NONE_CONFIRMED", "HAS_HISTORY"]), reason: z.string().min(3).max(500) }).parse(b);
      return confirmHistory(ctx, id, v.state, v.reason);
    }
    case "dnc-lift":
      return liftDnc(ctx, id, reason.parse(b).reason);
    case "dial":
      return recordDialIntent(ctx, id, z.object({ idempotencyKey: z.string().min(8).max(100) }).parse(b).idempotencyKey);
    case "activity":
      return addActivity(ctx, { ...(b as object), businessId: id } as Parameters<typeof addActivity>[1]);
    case "merge": {
      const v = z.object({ otherId: z.string().min(1), reason: z.string().min(3).max(500) }).parse(b);
      return mergeBusinesses(ctx, id, v.otherId, v.reason);
    }
    case "distinct":
      return resolveDistinct(ctx, id, z.object({ reason: z.string().min(3).max(500) }).parse(b).reason);
    default:
      throw new DomainError("NOT_FOUND", "Непознато действие.");
  }
});
