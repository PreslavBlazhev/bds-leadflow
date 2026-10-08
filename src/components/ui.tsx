import Link from "next/link";
import type { ReactNode } from "react";

const eur = new Intl.NumberFormat("bg-BG", { style: "currency", currency: "EUR" });
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return eur.format(cents / 100);
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "demo";
const TONES: Record<Tone, string> = {
  neutral: "border-line text-muted",
  ok: "border-emerald-700 text-ok",
  warn: "border-amber-700 text-warn",
  bad: "border-red-800 text-bad",
  info: "border-blue-700 text-accent-2",
  demo: "border-fuchsia-700 text-fuchsia-300",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export type StateLabel = "WORKING_LOCAL" | "DEMO_SIMULATED" | "IMPLEMENTED_NOT_LIVE_VERIFIED" | "BLOCKED";
const STATE_TEXT: Record<StateLabel, [string, Tone, string]> = {
  WORKING_LOCAL: ["WORKING LOCAL", "ok", "●"],
  DEMO_SIMULATED: ["DEMO / SIMULATED", "demo", "◆"],
  IMPLEMENTED_NOT_LIVE_VERIFIED: ["NOT LIVE-VERIFIED", "warn", "▲"],
  BLOCKED: ["BLOCKED", "bad", "■"],
};
export function StateBadge({ state, title }: { state: StateLabel; title?: string }) {
  const [t, tone, icon] = STATE_TEXT[state];
  return (
    <Badge tone={tone} title={title}>
      <span aria-hidden>{icon}</span>
      {t}
    </Badge>
  );
}

export function PageHeader({ title, sub, actions, state }: { title: string; sub?: ReactNode; actions?: ReactNode; state?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          {state}
        </div>
        {sub && <div className="mt-0.5 text-sm text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-fg";
  return (
    <div className="card px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={`tabular text-xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card px-4 py-6 text-center">
      <div className="font-medium">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "bad" | "info" | "ok"; children: ReactNode }) {
  const map = { warn: ["border-amber-700 bg-amber-950/30", "⚠", "Внимание"], bad: ["border-red-800 bg-red-950/30", "✖", "Грешка"], info: ["border-blue-800 bg-blue-950/30", "ℹ", "Информация"], ok: ["border-emerald-800 bg-emerald-950/30", "✔", "OK"] } as const;
  const [cls, icon, sr] = map[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`flex gap-2 rounded-lg border px-3 py-2 text-sm ${cls}`}>
      <span aria-hidden className="mt-px">
        {icon}
      </span>
      <span className="sr-only">{sr}: </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Section({ title, count, children, actions, id }: { title: string; count?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="mb-6" aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id ? `${id}-h` : undefined} className="text-base font-semibold">
          {title} {count !== undefined && <span className="tabular ml-1 text-sm font-normal text-muted">({count})</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Tabs({ items, current }: { items: { key: string; label: string; href: string; count?: number }[]; current: string }) {
  return (
    <nav aria-label="Раздели" className="mb-3 flex flex-wrap gap-1 border-b border-line">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm no-underline ${t.key === current ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {t.label}
          {t.count !== undefined && <span className="tabular ml-1 text-xs">({t.count})</span>}
        </Link>
      ))}
    </nav>
  );
}

export function scoreTone(score: number | null | undefined): "ok" | "warn" | "neutral" {
  if (score === null || score === undefined) return "neutral";
  return score >= 50 ? "ok" : score >= 30 ? "warn" : "neutral";
}
