import { z } from "zod";
import { recordPushReceipt } from "@/domain/notifications";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";

/**
 * Разписка от service worker-а (без вход — SW може да няма валидна сесия). Защита: еднократният token от
 * криптирания push payload (в базата е само sha256) + Origin проверка. Отговорът не издава дали token-ът съществува.
 */
const input = z.object({ rt: z.string().min(16).max(64), event: z.enum(["shown", "clicked"]) });

export const POST = api(
  async (ctx, req) => {
    const v = input.parse(await jsonBody(req));
    await recordPushReceipt(ctx.db, v.rt, v.event, new Date());
    return { ok: true };
  },
  { auth: false },
);
