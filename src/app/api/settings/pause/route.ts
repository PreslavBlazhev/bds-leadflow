import { z } from "zod";
import { getSettings, saveSettings } from "@/domain/settings";
import { jsonBody } from "@/lib/body";
import { audit } from "@/lib/db";
import { api } from "@/lib/server";

/** Пауза/възобновяване САМО на новите дневни списъци (последващите действия продължават). */
export const POST = api(async (ctx, req) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(await jsonBody(req));
  const s = await getSettings(ctx.db);
  await saveSettings(ctx.db, { ...s, pauseNewLists: paused });
  await audit(ctx.db, ctx.actor, paused ? "settings.pause_new_lists" : "settings.resume_new_lists");
  return { pauseNewLists: paused };
});
