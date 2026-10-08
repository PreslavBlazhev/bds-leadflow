import { addManualLead, type manualLeadInput } from "@/domain/crm";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import type { z } from "zod";

/** Ръчно добавяне (с identity matching; дубликатите отиват в проверка, не стават нови). */
export const POST = api(async (ctx, req) => addManualLead(ctx, (await jsonBody(req)) as z.input<typeof manualLeadInput>));
