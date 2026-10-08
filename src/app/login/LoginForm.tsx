"use client";

import { useState } from "react";
import { callApi } from "@/components/client/api";

export function LoginForm({ next }: { next: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setErr(null);
        const r = await callApi("/api/auth/login", { username: f.get("username"), password: f.get("password") });
        setBusy(false);
        if (!r.ok) return setErr(r.error ?? "Неуспешен вход.");
        window.location.href = next;
      }}
    >
      <div>
        <label className="label" htmlFor="username">
          Потребителско име
        </label>
        <input id="username" name="username" className="field" autoComplete="username" required />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Парола
        </label>
        <input id="password" name="password" type="password" className="field" autoComplete="current-password" required />
      </div>
      {err && (
        <p role="alert" className="text-sm text-bad">
          {err}
        </p>
      )}
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Влизане…" : "Вход"}
      </button>
    </form>
  );
}
