import { z } from "zod";
import { completeFollowUp, rescheduleFollowUp } from "@/domain/crm";
import { DomainError } from "@/domain/errors";
import { convertLocalDates, jsonBody } from "@/lib/body";
import { api } from "@/lib/server";

export const POST = api(async (ctx, req, p) => {
  const b = convertLocalDates(await jsonBody(req));
  if (p.action === "complete") return completeFollowUp(ctx, p.id!, z.object({ note: z.string().max(2000).optional() }).parse(b).note);
  if (p.action === "reschedule") return rescheduleFollowUp(ctx, p.id!, z.object({ dueAt: z.date({ error: "Избери дата и час." }) }).parse(b).dueAt);
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});
