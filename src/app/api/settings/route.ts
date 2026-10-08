import { audit } from "@/lib/db";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";
import { rescore } from "@/domain/rescore";
import { saveSettings } from "@/domain/settings";

/** Валидирани настройки. Промяна на часа влияе само на следващото изпълнение (днешният публикуван списък остава). */
export const PUT = api(async (ctx, req) => {
  const s = await saveSettings(ctx.db, await jsonBody(req));
  await rescore(ctx.db, ctx.clock.now());
  await audit(ctx.db, ctx.actor, "settings.save");
  return s;
});
