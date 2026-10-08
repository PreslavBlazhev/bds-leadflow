import { recordOutcome, type OutcomeInput } from "@/domain/outcomes";
import { convertLocalDates, jsonBody } from "@/lib/body";
import { api } from "@/lib/server";

export const POST = api(async (ctx, req) => {
  const body = convertLocalDates(await jsonBody(req));
  return recordOutcome(ctx, body as unknown as OutcomeInput);
});
