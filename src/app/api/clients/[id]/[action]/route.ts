import { recordPayment, updateClient, type paymentInput } from "@/domain/crm";
import { DomainError } from "@/domain/errors";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import type { z } from "zod";

export const POST = api(async (ctx, req, p) => {
  const b = await jsonBody(req);
  if (p.action === "edit") return updateClient(ctx, p.id!, b);
  if (p.action === "payment") return recordPayment(ctx, { ...(b as object), clientId: p.id! } as z.input<typeof paymentInput>);
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});
