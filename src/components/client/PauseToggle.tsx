"use client";

import { ActionButton } from "./ActionButton";

/** Ясно състояние + действие: пауза / възобновяване на новите списъци. */
export function PauseToggle({ paused }: { paused: boolean }) {
  return paused ? (
    <ActionButton url="/api/settings/pause" body={{ paused: false }} className="btn btn-sm btn-primary">
      Възобнови новите списъци
    </ActionButton>
  ) : (
    <ActionButton url="/api/settings/pause" body={{ paused: true }} className="btn btn-sm" confirmText="пауза на новите списъци">
      Пауза на новите списъци
    </ActionButton>
  );
}
