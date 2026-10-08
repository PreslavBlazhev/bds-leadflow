import { setOfferStatus, updateOffer, type offerStatusInput } from "@/domain/crm";
import { DomainError } from "@/domain/errors";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import type { z } from "zod";

export const POST = api(async (ctx, req, p) => {
  const b = await jsonBody(req);
  if (p.action === "edit") return updateOffer(ctx, p.id!, b);
  if (p.action === "status") return setOfferStatus(ctx, p.id!, b as z.input<typeof offerStatusInput>);
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});
