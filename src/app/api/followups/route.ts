import { createFollowUp, type followUpCreate } from "@/domain/crm";
import { convertLocalDates, jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import type { z } from "zod";

export const POST = api(async (ctx, req) => createFollowUp(ctx, convertLocalDates(await jsonBody(req)) as z.input<typeof followUpCreate>));
