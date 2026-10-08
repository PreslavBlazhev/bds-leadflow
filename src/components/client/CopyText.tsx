"use client";

import { useState } from "react";

export function CopyText({ text }: { text: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMsg("Копирано.");
          } catch {
            setMsg("Браузърът не позволи копиране — маркирай текста ръчно.");
          }
        }}
      >
        Копирай текста
      </button>
      {msg && <span role="status">{msg}</span>}
    </span>
  );
}
