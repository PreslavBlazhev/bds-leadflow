"use client";

import { useState } from "react";
import { ActionButton } from "./ActionButton";
import { callApi } from "./api";
import { Dialog } from "./Dialog";

interface PreviewData {
  localDate: string;
  poolSize: number;
  existingCount: number;
  target: number;
  notes: string[];
  items: { id: string; ref: string; name: string; city: string; score: number; reason: string }[];
}

/** „Прегледай утре“ — само четене; нищо не се резервира. */
export function TomorrowPreview() {
  const [data, setData] = useState<PreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="mb-6" aria-label="Преглед на утрешния списък">
      <button
        type="button"
        className="btn"
        onClick={async () => {
          setErr(null);
          const r = await callApi<PreviewData>("/api/batch/preview", undefined, "GET");
          if (!r.ok) return setErr(r.error ?? "Грешка");
          setData(r.data!);
        }}
      >
        Прегледай утре (без резервиране)
      </button>
      {err && (
        <p role="alert" className="mt-1 text-sm text-bad">
          {err}
        </p>
      )}
      <Dialog open={!!data} onClose={() => setData(null)} title={`Преглед за ${data?.localDate ?? ""} — без резервиране`} wide>
        {data && (
          <div className="space-y-2 text-sm">
            <p className="text-muted">
              Допустим резерв сега: {data.poolSize}. Биха се избрали {data.items.length}/{data.target}. Това е само преглед — утре eligibility се проверява отново при публикуване и изборът може да се различава.
            </p>
            {data.notes.map((n) => (
              <p key={n}>• {n}</p>
            ))}
            <ol className="list-decimal space-y-0.5 pl-6">
              {data.items.map((i) => (
                <li key={i.id}>
                  {i.name} — {i.city} — score {i.score}
                </li>
              ))}
            </ol>
          </div>
        )}
      </Dialog>
    </section>
  );
}

interface NotifPreview {
  localDate: string;
  payload: { title: string; body: string } | null;
  push: { status: string; attempts: number; lastError: string | null } | null;
  email: { status: string; notBefore: string; lastError: string | null; preview: { subject: string; text: string } | null } | null;
}

/** Отделен, ясно обозначен demo панел. Не сменя системния часовник и не изпраща истински известия. */
export function DemoPanel() {
  const [notif, setNotif] = useState<NotifPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="mb-6 rounded-lg border border-dashed border-fuchsia-700 p-3" aria-labelledby="demo-h">
      <h2 id="demo-h" className="text-base font-semibold text-fuchsia-300">
        ◆ Демо контроли (DEMO / SIMULATED)
      </h2>
      <p className="mb-3 text-xs text-muted">Работят само в demo базата. Не променят системния часовник, не създават истински известия и не засягат real данни.</p>
      <div className="flex flex-wrap items-start gap-2">
        <ActionButton
          url="/api/batch/prepare"
          resultText={(d) => {
            const r = d as { reserveBefore: number; reserveAfter: number; note: string };
            return `Резерв ${r.reserveBefore} → ${r.reserveAfter}. ${r.note}`;
          }}
        >
          Подготви кандидати
        </ActionButton>
        <ActionButton
          url="/api/batch/publish"
          resultText={(d) => {
            const r = d as { created: boolean; added: number; total: number; target: number };
            return r.created || r.added ? `Списък: ${r.total}/${r.target}` : `Вече съществува: ${r.total}/${r.target} (същият списък)`;
          }}
        >
          Създай списък
        </ActionButton>
        <ActionButton
          url="/api/batch/next-day"
          confirmText="следващ демо ден"
          resultText={(d) => {
            const r = d as { localDate: string; publish: { total: number; target: number } };
            return `Демо ден ${r.localDate}: ${r.publish.total}/${r.publish.target} нови`;
          }}
        >
          Симулирай следващ ден
        </ActionButton>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setErr(null);
            const r = await callApi<NotifPreview>("/api/notifications/preview", undefined, "GET");
            if (!r.ok) return setErr(r.error ?? "Грешка");
            setNotif(r.data!);
          }}
        >
          Покажи известието
        </button>
      </div>
      {err && (
        <p role="alert" className="mt-1 text-sm text-bad">
          {err}
        </p>
      )}
      <Dialog open={!!notif} onClose={() => setNotif(null)} title="Преглед на известието (in-app preview, НЕ е изпратено)">
        {notif && (
          <div className="space-y-3 text-sm">
            {notif.payload ? (
              <div className="rounded-lg border border-line bg-bg p-3">
                <div className="text-xs text-muted">Push (payload без имена/телефони)</div>
                <div className="font-semibold">{notif.payload.title}</div>
                <div>{notif.payload.body}</div>
                <div className="mt-1 text-xs text-muted">
                  Статус: {notif.push?.status ?? "няма запис"} {notif.push?.lastError ? `· ${notif.push.lastError}` : ""}
                </div>
              </div>
            ) : (
              <p>Няма известие за днес (няма публикуван списък или известията са изключени).</p>
            )}
            {notif.email && (
              <div className="rounded-lg border border-line bg-bg p-3">
                <div className="text-xs text-muted">Резервен имейл — fallback по липса на отваряне (preview)</div>
                <div className="text-xs text-muted">
                  Статус: {notif.email.status} · не по-рано от {new Date(notif.email.notBefore).toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })}
                </div>
                {notif.email.preview && (
                  <>
                    <div className="mt-1 font-semibold">{notif.email.preview.subject}</div>
                    <pre className="mt-1 text-xs whitespace-pre-wrap">{notif.email.preview.text}</pre>
                  </>
                )}
                <p className="mt-1 text-xs text-muted">„acknowledged“ = списъкът е отворен преди fallback-а → имейлът не се изпраща. В demo нищо не се изпраща.</p>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </section>
  );
}
