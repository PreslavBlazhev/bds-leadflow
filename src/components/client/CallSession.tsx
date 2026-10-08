"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { fmtDateTime } from "@/lib/time";
import { OUTCOME_LABELS } from "@/domain/constants";
import { Dialog } from "./Dialog";
import { DialButton } from "./LeadActions";
import { OutcomeForm, type PackageOpt } from "./OutcomeForm";

export interface QueueItem {
  id: string;
  ref: string;
  name: string;
  city: string;
  category: string;
  phone: string;
  canDial: boolean;
  dialReason: string | null;
  blockedReason: string | null;
  queueNote: string;
  reasons: string[];
  details: string[];
  opening: string;
  questions: string;
  pitchIsTemplate: boolean;
  recent: string[];
  openOffers: { id: string; service: string; oneTimeCents: number; monthlyCents: number | null }[];
}

const DESKTOP_MQ = "(min-width: 1024px)";
function subscribeMq(cb: () => void) {
  const m = window.matchMedia(DESKTOP_MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

export function CallSession({
  queueKey,
  queueLabel,
  queue: initialQueue,
  startIndex,
  newProgress,
  otherQueues,
  packages,
  today,
  mode,
  callWindow,
  retryDefault,
}: {
  queueKey: string;
  queueLabel: string;
  queue: QueueItem[];
  startIndex: number;
  newProgress: { total: number; done: number } | null;
  otherQueues: { key: string; label: string; count: number }[];
  packages: PackageOpt[];
  today: string;
  mode: "demo" | "real";
  callWindow: { start: string; end: string };
  retryDefault?: { local: string; workdays: number };
}) {
  const router = useRouter();
  // Снимка на опашката: refresh след запис не размества поредността в текущата сесия.
  const [queue] = useState(initialQueue);
  const [i, setI] = useState(Math.min(startIndex, Math.max(0, initialQueue.length - 1)));
  const [done, setDone] = useState<Set<string>>(new Set());
  const [simulatedId, setSimulatedId] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  const isDesktop = useSyncExternalStore(subscribeMq, () => window.matchMedia(DESKTOP_MQ).matches, () => false);
  void queueKey;

  if (queue.length === 0) {
    return (
      <div className="card p-5 text-center">
        <p className="font-medium">Няма контакти в „{queueLabel}“.</p>
        {otherQueues.length > 0 ? (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {otherQueues.map((q) => (
              <Link key={q.key} href={`/calls?queue=${q.key}`} className="btn btn-sm">
                {q.label} ({q.count})
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">Всички опашки са празни.</p>
        )}
      </div>
    );
  }

  const cur = queue[i]!;
  const simulated = simulatedId === cur.id;
  const nowHm = new Date().toLocaleTimeString("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false });
  const outsideWindow = nowHm < callWindow.start || nowHm > callWindow.end;
  const sessionDone = done.size;
  const progressDone = newProgress ? newProgress.done + sessionDone : sessionDone;
  const progressTotal = newProgress ? newProgress.total : queue.length;

  function onSaved(r: { duplicate: boolean; outcome: keyof typeof OUTCOME_LABELS; retryAt?: string }) {
    setLastSaved(
      `Записано: ${OUTCOME_LABELS[r.outcome]} — ${cur.name}${r.duplicate ? " (вече беше записано, без дублиране)" : ""}${r.retryAt ? ` · повторно обаждане: ${fmtDateTime(r.retryAt)}` : ""}`,
    );
    const nextDone = new Set(done).add(cur.id);
    setDone(nextDone);
    setSheetOpen(false);
    // следващият НЕзаписан контакт напред в опашката
    const next = queue.findIndex((q, idx) => idx > i && !nextDone.has(q.id));
    if (next >= 0) setI(next);
    else setFinished(true);
    router.refresh();
  }

  const form = (
    <OutcomeForm
      key={cur.id}
      businessId={cur.id}
      blockedReason={cur.blockedReason}
      packages={packages}
      openOffers={cur.openOffers}
      today={today}
      compact
      shortcuts={isDesktop}
      submitLabel="Запази и следващ"
      onSaved={onSaved}
      retryDefault={retryDefault}
    />
  );

  return (
    <div className="mx-auto max-w-6xl pb-28 lg:pb-0">
      {/* Лента с позиция и навигация — в потока на страницата, никога не застъпва съдържанието. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <div className="tabular font-medium" aria-live="polite">
            {queueLabel}: контакт {i + 1} от {queue.length}
          </div>
          <div className="tabular text-xs text-muted">
            {newProgress ? `Обработени от списъка: ${progressDone} от ${progressTotal}` : `Записани в тази сесия: ${sessionDone} от ${queue.length}`}
          </div>
          <div className="mt-1 h-1.5 w-48 overflow-hidden rounded bg-card" role="progressbar" aria-valuemin={0} aria-valuemax={progressTotal} aria-valuenow={progressDone} aria-label="Прогрес на опашката">
            <div className="h-full bg-accent" style={{ width: `${progressTotal ? (progressDone / progressTotal) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setFinished(false);
              setI((x) => Math.max(0, x - 1));
            }}
            disabled={i === 0}
          >
            ← Предишен
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setFinished(false);
              setI((x) => Math.min(queue.length - 1, x + 1));
            }}
            disabled={i >= queue.length - 1}
          >
            Пропусни засега →
          </button>
        </div>
      </div>

      {lastSaved && (
        <p role="status" className="mb-2 rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-ok">
          ✔ {lastSaved}
        </p>
      )}
      {finished && (
        <div role="status" className="mb-3 rounded-md border border-blue-800 bg-blue-950/30 px-3 py-2 text-sm">
          Опашката „{queueLabel}“ е минала докрай.
          {otherQueues.map((q) => (
            <Link key={q.key} href={`/calls?queue=${q.key}`} className="ml-2">
              {q.label} ({q.count})
            </Link>
          ))}
        </div>
      )}
      {outsideWindow && <p className="mb-2 text-xs text-warn">▲ Извън служебния прозорец за обаждания ({callWindow.start}–{callWindow.end}).</p>}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] lg:items-start lg:gap-4">
        <article className="card p-4" aria-label={`Текущ контакт: ${cur.name}`}>
          <div className="text-xs text-muted">{cur.queueNote}</div>
          <h2 className="mt-1 text-2xl font-semibold break-words">
            {cur.name} {done.has(cur.id) && <span className="text-sm font-normal text-ok">✔ записан</span>}
          </h2>
          <div className="text-sm text-muted">
            {cur.city} · {cur.category} · <Link href={`/leads/${cur.id}`}>{cur.ref} — всички данни</Link>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="tabular text-xl font-medium">{cur.phone}</span>
            {cur.canDial ? (
              <DialButton businessId={cur.id} />
            ) : mode === "demo" && !cur.blockedReason ? (
              <button type="button" className="btn btn-sm" onClick={() => setSimulatedId(cur.id)} title="Демо: без tel: към синтетичен номер">
                Симулирай обаждане
              </button>
            ) : (
              <span className="flex flex-col">
                <button type="button" className="btn btn-sm" disabled>
                  Позвъни
                </button>
                <span className="text-xs text-muted">{cur.dialReason}</span>
              </span>
            )}
          </div>
          {simulated && (
            <p role="status" className="mt-2 rounded-md border border-fuchsia-700 p-2 text-sm">
              ◆ Симулация: нищо не е набрано. След разговора запиши резултата.
            </p>
          )}

          {cur.reasons.length > 0 && (
            <div className="mt-3">
              <span className="text-xs text-muted">Защо е избран: </span>
              <span className="inline-flex flex-wrap gap-1.5 align-middle">
                {cur.reasons.map((r) => (
                  <span key={r} className="rounded-md border border-line-strong px-1.5 py-0.5 text-xs">
                    {r}
                  </span>
                ))}
              </span>
            </div>
          )}

          <div className="mt-3 rounded-lg border border-line bg-bg p-3">
            <div className="text-xs text-muted">{cur.pitchIsTemplate ? "Как да започнеш (шаблон, не е AI)" : "Моето начало на разговор"}</div>
            <p className="mt-1 text-sm">{cur.opening}</p>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-xs text-muted">Въпроси за разговора</summary>
              <p className="mt-1 whitespace-pre-wrap text-muted">{cur.questions}</p>
            </details>
          </div>

          {cur.recent.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-xs text-muted">Последни действия ({cur.recent.length})</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {cur.recent.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </details>
          )}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-xs text-muted">Подробности (оценка и проверка на сайта)</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
              {cur.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        </article>

        {isDesktop && (
          <aside className="card mt-4 p-4 lg:sticky lg:top-16 lg:mt-0 lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto" aria-label="Запис на резултат">
            {form}
          </aside>
        )}
      </div>

      {!isDesktop && (
        <>
          {/* Постоянен бутон над долната навигация; страницата има pb-28, за да не се застъпва съдържание. */}
          <div className="fixed inset-x-0 z-30 border-t border-line bg-panel px-3 py-2" style={{ bottom: "calc(3.5rem + env(safe-area-inset-bottom))" }}>
            <button type="button" className="btn btn-primary w-full" onClick={() => setSheetOpen(true)} disabled={!!cur.blockedReason}>
              {cur.blockedReason ? "Обажданията са блокирани (DNC)" : "Запиши резултат"}
            </button>
          </div>
          <Dialog open={sheetOpen} onClose={() => setSheetOpen(false)} title={`Резултат: ${cur.name}`} keepMounted>
            {form}
          </Dialog>
        </>
      )}
    </div>
  );
}
