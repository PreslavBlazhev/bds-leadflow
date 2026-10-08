import Link from "next/link";
import { BottomNav, LogoutButton, SideNav } from "@/components/client/Nav";
import { SwRegister } from "@/components/client/SwRegister";
import { Badge } from "@/components/ui";
import { healthSummary } from "@/domain/health";
import { getSettings } from "@/domain/settings";
import { activeList, realOnlyFor } from "@/domain/activeList";
import { getEnv } from "@/lib/env";
import { requirePageOwner } from "@/lib/server";
import { addDays, fmtDate, localDateOf, WEEKDAY_LABELS, weekdayOf, zonedToUtc } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageOwner();
  const env = getEnv();
  const now = ctx.clock.now();
  const today = localDateOf(now);
  const meta = await ctx.db.systemMeta.findUnique({ where: { id: 1 } });
  const endOfToday = zonedToUtc(addDays(today, 1), "00:00");
  const settings = await getSettings(ctx.db);
  const realSource = ctx.mode === "demo" && settings.leadSource === "REAL";
  const [h, dueFollowUps, batch] = await Promise.all([
    healthSummary(ctx.db, env, ctx.mode, now),
    ctx.db.followUp.count({ where: { status: "OPEN", dueAt: { lt: endOfToday }, ...(realSource ? { business: { isDemo: false } } : {}) } }),
    ctx.db.dailyBatch.findUnique({ where: { localDate: today }, include: { _count: { select: { items: true } } } }),
  ]);
  const offset = meta?.demoDayOffset ?? 0;
  // Реален режим: броячът „Днес“ = оставащите в активния списък (може да е от предишна дата).
  const todayCount = realOnlyFor(ctx.mode, settings) ? (await activeList(ctx.db, { realOnly: true })).remaining : batch?._count.items;
  const statusTone = h.worker.status === "stale" || h.worker.status === "none" ? "bad" : !h.workerAlive || h.failedN > 0 ? "warn" : "ok";
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <aside className="hidden border-r border-line bg-panel md:flex md:min-h-screen md:flex-col md:gap-4 md:p-3">
        <Link href="/today" className="px-2 pt-1 text-base font-semibold text-fg no-underline">
          BDS LeadFlow
        </Link>
        <SideNav counts={{ "/today": todayCount, "/follow-ups": dueFollowUps }} />
        <div className="mt-auto space-y-2 px-2 pb-2 text-xs text-muted">
          {realSource ? (
            <Badge tone="info" title="Новите списъци са само от реалните (импортирани) бизнеси. Демо историята е запазена; известията остават симулирани (APP_MODE=demo).">
              Реални списъци · демо история запазена
            </Badge>
          ) : ctx.mode === "demo" ? (
            <Badge tone="demo">◆ ДЕМО режим — синтетични данни</Badge>
          ) : (
            <Badge tone="info">REAL режим</Badge>
          )}
          <div>Вход: {ctx.username}</div>
        </div>
      </aside>
      <div className="min-w-0 pb-20 md:pb-6">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-bg px-3 py-2 md:px-5">
          <Link href="/today" className="mr-1 font-semibold text-fg no-underline md:hidden">
            LeadFlow
          </Link>
          <div className="text-sm">
            <span className="tabular font-medium">
              {WEEKDAY_LABELS[weekdayOf(today) - 1]}, {fmtDate(today)}
            </span>
            {ctx.mode === "demo" && offset > 0 && (
              <span className="ml-2">
                <Badge tone="demo" title="Демо часовник — системният часовник не е променен">
                  симулиран ден +{offset}
                </Badge>
              </span>
            )}
          </div>
          <form action="/leads" method="get" role="search" className="order-last w-full md:order-none md:ml-4 md:w-72">
            <label htmlFor="global-q" className="sr-only">
              Търсене на бизнес
            </label>
            <input id="global-q" name="q" type="search" placeholder="Търси бизнес, град, телефон…" className="field min-h-9 py-1.5 text-sm" />
          </form>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/settings?tab=health" className="no-underline" title="Статус на системата">
              <Badge tone={statusTone}>
                <span aria-hidden>{statusTone === "ok" ? "●" : statusTone === "warn" ? "▲" : "■"}</span>
                {h.workerAlive ? "Worker работи" : h.worker.status === "problem" ? "Worker: проверка" : "Worker не работи"}
                {h.failedN > 0 ? ` · ${h.failedN} грешки` : ""}
              </Badge>
            </Link>
            {ctx.mode === "demo" && !realSource && (
              <span className="md:hidden">
                <Badge tone="demo">ДЕМО</Badge>
              </span>
            )}
            <LogoutButton />
          </div>
        </header>
        <main id="main" className="px-3 py-4 md:px-5">
          {children}
        </main>
      </div>
      <BottomNav followUps={dueFollowUps} />
      <SwRegister />
    </div>
  );
}
