import Link from "next/link";
import { ACTIVITY_LABELS, CATEGORY_LABELS, OUTCOME_LABELS, STAGE_LABELS, WEBSITE_STATUS_LABELS, type ActivityType, type Outcome, type Stage } from "@/domain/constants";
import { formatPhone } from "@/domain/identity";
import { fmtDate } from "@/lib/time";
import { Badge, scoreTone } from "./ui";

export interface LeadListRow {
  id: string;
  ref: string;
  name: string;
  city: string;
  category: string;
  rating: number | null;
  reviewCount: number | null;
  websiteStatus: string;
  score: number | null;
  phoneNormalized: string | null;
  phoneKind: string | null;
  pipelineStage: string;
  position?: number;
  reason?: string | null;
  issuedOn?: string | null;
  lastActivity?: { type: string; outcome: string | null; occurredAt: Date } | null;
  flags?: string[];
}

function last(r: LeadListRow) {
  if (!r.lastActivity) return <span className="text-muted">Няма</span>;
  const a = r.lastActivity;
  return (
    <span>
      {a.outcome ? OUTCOME_LABELS[a.outcome as Outcome] : ACTIVITY_LABELS[a.type as ActivityType]} <span className="text-xs text-muted">{fmtDate(a.occurredAt)}</span>
    </span>
  );
}

function rating(r: LeadListRow) {
  return r.rating !== null ? (
    <span className="tabular">
      {r.rating.toFixed(1)} <span className="text-xs text-muted">({r.reviewCount ?? "?"})</span>
    </span>
  ) : (
    <span className="text-muted">няма данни</span>
  );
}

/** Desktop: компактна таблица; телефон: карти (без смаляване на таблицата). */
export function LeadList({ rows, hrefFor, selectedId, showPosition, showStage, caption }: { rows: LeadListRow[]; hrefFor: (id: string) => string; selectedId?: string; showPosition?: boolean; showStage?: boolean; caption: string }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-line lg:block">
        <table className="data">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {showPosition && <th scope="col">#</th>}
              <th scope="col">Бизнес</th>
              <th scope="col">Град / тип</th>
              <th scope="col">Рейтинг</th>
              <th scope="col">Сайт</th>
              <th scope="col">Score</th>
              <th scope="col">Телефон</th>
              {showStage && <th scope="col">Етап</th>}
              <th scope="col">Причина за подбора</th>
              <th scope="col">Последно</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} aria-selected={selectedId === r.id} className={selectedId === r.id ? "[&>td]:bg-[#16263d]" : ""}>
                {showPosition && <td className="tabular text-muted">{r.position}</td>}
                <td className="max-w-56">
                  <Link href={hrefFor(r.id)} className="font-medium text-fg">
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted">
                    {r.ref}
                    {r.issuedOn && ` · издаден ${fmtDate(r.issuedOn)}`}
                  </div>
                  {r.flags && r.flags.length > 0 && (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {r.flags.map((f) => (
                        <Badge key={f} tone={f.startsWith("DNC") ? "bad" : "warn"}>
                          {f}
                        </Badge>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {r.city}
                  <div className="text-xs text-muted">{CATEGORY_LABELS[r.category] ?? r.category}</div>
                </td>
                <td>{rating(r)}</td>
                <td className="text-xs">{WEBSITE_STATUS_LABELS[r.websiteStatus] ?? r.websiteStatus}</td>
                <td>
                  <Badge tone={scoreTone(r.score)}>{r.score ?? "—"}</Badge>
                </td>
                <td className="text-xs whitespace-nowrap">{formatPhone(r.phoneNormalized, r.phoneKind)}</td>
                {showStage && <td className="text-xs">{STAGE_LABELS[r.pipelineStage as Stage]}</td>}
                <td className="max-w-72 text-xs text-muted">{r.reason ?? "—"}</td>
                <td className="text-xs">{last(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 lg:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={hrefFor(r.id)} className={`card block p-3 text-fg no-underline ${selectedId === r.id ? "ring-1 ring-accent" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium break-words">
                    {showPosition && <span className="tabular mr-1 text-muted">{r.position}.</span>}
                    {r.name}
                  </div>
                  <div className="text-xs text-muted">
                    {r.city} · {CATEGORY_LABELS[r.category] ?? r.category} · {r.ref}
                  </div>
                </div>
                <Badge tone={scoreTone(r.score)}>Score {r.score ?? "—"}</Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                <span>Рейтинг: {rating(r)}</span>
                <span>Сайт: {WEBSITE_STATUS_LABELS[r.websiteStatus]}</span>
                <span>{formatPhone(r.phoneNormalized, r.phoneKind)}</span>
                {showStage && <span>Етап: {STAGE_LABELS[r.pipelineStage as Stage]}</span>}
              </div>
              {r.reason && <div className="mt-1 text-xs">{r.reason}</div>}
              <div className="mt-1 text-xs">Последно: {last(r)}</div>
              {r.flags && r.flags.length > 0 && <div className="mt-1 text-xs text-warn">{r.flags.join(" · ")}</div>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
