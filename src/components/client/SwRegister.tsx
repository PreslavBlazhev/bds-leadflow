"use client";

import { useEffect } from "react";

/** Регистрира service worker-а (offline shell + push). НЕ иска разрешение за известия. */
export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
