"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton } from "./ActionButton";
import { callApi, newKey } from "./api";
import { Dialog } from "./Dialog";

type EditFields = Record<"name" | "city" | "address" | "phone" | "website" | "socialUrl" | "contactPersonName" | "contactPersonRole" | "openingLine" | "questions" | "notes", string>;

const EDIT_LABELS: Record<keyof EditFields, string> = {
  name: "Име на бизнеса",
  city: "Град",
  address: "Адрес",
  phone: "Служебен телефон",
  website: "Сайт (http/https)",
  socialUrl: "Социална връзка (http/https)",
  contactPersonName: "Лице за контакт (само ако е надеждно установено)",
  contactPersonRole: "Роля",
  openingLine: "Начало на разговор (празно = шаблон)",
  questions: "Въпроси",
  notes: "Бележки",
};

export function DialButton({ businessId }: { businessId: string }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex flex-col">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={async () => {
          // Само dial_intent: НЕ е опит/разговор. Резултатът се записва изрично след разговора.
          const r = await callApi<{ tel: string }>(`/api/leads/${businessId}/dial`, { idempotencyKey: newKey() });
          if (!r.ok || !r.data) return setErr(r.error ?? "Грешка");
          window.location.href = r.data.tel;
        }}
      >
        Позвъни
      </button>
      <span className="text-xs text-muted">Отваря tel:. Не се брои като обаждане.</span>
      {err && (
        <span role="alert" className="text-xs text-bad">
          {err}
        </span>
      )}
    </span>
  );
}

export function LeadActions({
  businessId,
  dnc,
  archived,
  historyUnknown,
  dupes,
  inReview,
  edit,
}: {
  businessId: string;
  dnc: boolean;
  archived: boolean;
  historyUnknown: boolean;
  dupes: { id: string; ref: string; name: string }[];
  inReview: boolean;
  edit: EditFields;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<null | "edit" | "note" | "followup">(null);
  const [form, setForm] = useState<EditFields>(edit);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteType, setNoteType] = useState<"NOTE" | "MEETING">("NOTE");
  const [text, setText] = useState("");
  const [noteKey, setNoteKey] = useState(newKey);
  const [fu, setFu] = useState({ dueAtLocal: "", reason: "", note: "" });
  const [reason, setReason] = useState("");

  async function submit(url: string, body: unknown, after?: () => void) {
    setBusy(true);
    setErr(null);
    const r = await callApi(url, body);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "Грешка");
    after?.();
    setOpen(null);
    router.refresh();
  }

  return (
    <section className="mt-3 border-t border-line pt-3" aria-label="Действия">
      <h3 className="mb-2 text-sm font-semibold">Действия</h3>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setOpen("edit")}>
          Редактирай
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setOpen("note")}>
          Бележка / среща
        </button>
        {dnc ? (
          <span className="flex flex-col">
            <button type="button" className="btn btn-sm" disabled>
              Последващо действие
            </button>
            <span className="text-xs text-muted">DNC — блокирано.</span>
          </span>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setOpen("followup")}>
            Последващо действие
          </button>
        )}
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <label className="label" htmlFor={`reason-${businessId}`}>
            Причина (за архивиране, потвърждение, DNC премахване, сливане)
          </label>
          <input id={`reason-${businessId}`} className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          {archived ? (
            <ActionButton url={`/api/leads/${businessId}/restore`} body={{ reason }} className="btn btn-sm">
              Възстанови от архив
            </ActionButton>
          ) : (
            <ActionButton url={`/api/leads/${businessId}/archive`} body={{ reason }} className="btn btn-sm" disabledReason={reason.trim().length < 3 ? "въведи причина" : null}>
              Архивирай
            </ActionButton>
          )}
          {historyUnknown && (
            <>
              <ActionButton url={`/api/leads/${businessId}/history`} body={{ state: "NONE_CONFIRMED", reason }} className="btn btn-sm" disabledReason={reason.trim().length < 3 ? "въведи причина" : null}>
                Потвърди: никога не е контактуван
              </ActionButton>
              <ActionButton url={`/api/leads/${businessId}/history`} body={{ state: "HAS_HISTORY", reason }} className="btn btn-sm" disabledReason={reason.trim().length < 3 ? "въведи причина" : null}>
                Има история на контакт
              </ActionButton>
            </>
          )}
          {dnc && (
            <ActionButton url={`/api/leads/${businessId}/dnc-lift`} body={{ reason }} className="btn btn-sm btn-danger" confirmText="премахни DNC" disabledReason={reason.trim().length < 5 ? "нужна е причина (5+ символа)" : null}>
              Премахни DNC (owner, с audit)
            </ActionButton>
          )}
          {inReview && (
            <ActionButton url={`/api/leads/${businessId}/distinct`} body={{ reason }} className="btn btn-sm" disabledReason={reason.trim().length < 3 ? "въведи причина" : null}>
              Различни бизнеси (приключи проверката)
            </ActionButton>
          )}
          {dupes.map((x) => (
            <ActionButton key={x.id} url={`/api/leads/${businessId}/merge`} body={{ otherId: x.id, reason }} className="btn btn-sm" confirmText={`слей ${x.ref}`} disabledReason={reason.trim().length < 3 ? "въведи причина" : null}>
              Слей {x.ref} в този запис
            </ActionButton>
          ))}
        </div>
      </div>

      <Dialog open={open === "edit"} onClose={() => setOpen(null)} title="Редакция на контакт" wide>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const body: Record<string, string | null> = {};
            for (const k of Object.keys(form) as (keyof EditFields)[]) if (form[k] !== edit[k]) body[k] = form[k].trim() === "" && k !== "name" && k !== "city" ? null : form[k];
            void submit(`/api/leads/${businessId}/edit`, body);
          }}
        >
          {(Object.keys(EDIT_LABELS) as (keyof EditFields)[]).map((k) => (
            <div key={k} className={["openingLine", "questions", "notes"].includes(k) ? "sm:col-span-2" : ""}>
              <label className="label" htmlFor={`e-${k}`}>
                {EDIT_LABELS[k]}
              </label>
              {["openingLine", "questions", "notes"].includes(k) ? (
                <textarea id={`e-${k}`} className="field min-h-20" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              ) : (
                <input id={`e-${k}`} className="field" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              )}
            </div>
          ))}
          <p className="text-xs text-muted sm:col-span-2">Старите телефон/домейн остават като aliases — промяната не изчиства историята и не прави записа „нов“.</p>
          {err && (
            <p role="alert" className="text-sm text-bad sm:col-span-2">
              {err}
            </p>
          )}
          <div className="sm:col-span-2">
            <button className="btn btn-primary" disabled={busy}>
              Запази
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={open === "note"} onClose={() => setOpen(null)} title="Бележка или среща">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(`/api/leads/${businessId}/activity`, { type: noteType, note: text, idempotencyKey: noteKey }, () => {
              setText("");
              setNoteKey(newKey());
            });
          }}
        >
          <fieldset className="flex gap-4 text-sm">
            <legend className="label">Тип</legend>
            <label className="flex items-center gap-2">
              <input type="radio" checked={noteType === "NOTE"} onChange={() => setNoteType("NOTE")} /> Бележка (не е контакт)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={noteType === "MEETING"} onChange={() => setNoteType("MEETING")} /> Проведена среща
            </label>
          </fieldset>
          <div>
            <label className="label" htmlFor="note-text">
              Текст
            </label>
            <textarea id="note-text" className="field min-h-24" value={text} onChange={(e) => setText(e.target.value)} required />
          </div>
          {err && (
            <p role="alert" className="text-sm text-bad">
              {err}
            </p>
          )}
          <button className="btn btn-primary" disabled={busy || !text.trim()}>
            Запиши
          </button>
        </form>
      </Dialog>

      <Dialog open={open === "followup"} onClose={() => setOpen(null)} title="Последващо действие">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("/api/followups", { businessId, dueAtLocal: fu.dueAtLocal, reason: fu.reason, note: fu.note || undefined, kind: "GENERAL" });
          }}
        >
          <div>
            <label className="label" htmlFor="fu-when">
              Дата и час (българско време)
            </label>
            <input id="fu-when" type="datetime-local" className="field" required value={fu.dueAtLocal} onChange={(e) => setFu({ ...fu, dueAtLocal: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fu-reason">
              Причина
            </label>
            <input id="fu-reason" className="field" required value={fu.reason} onChange={(e) => setFu({ ...fu, reason: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="fu-note">
              Бележка
            </label>
            <textarea id="fu-note" className="field" value={fu.note} onChange={(e) => setFu({ ...fu, note: e.target.value })} />
          </div>
          {err && (
            <p role="alert" className="text-sm text-bad">
              {err}
            </p>
          )}
          <button className="btn btn-primary" disabled={busy}>
            Създай
          </button>
        </form>
      </Dialog>
    </section>
  );
}

