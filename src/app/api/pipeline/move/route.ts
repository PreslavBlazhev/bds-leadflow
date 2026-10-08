import { moveStage, type moveStageInput } from "@/domain/crm";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import type { z } from "zod";

export const POST = api(async (ctx, req) => moveStage(ctx, (await jsonBody(req)) as z.input<typeof moveStageInput>));
