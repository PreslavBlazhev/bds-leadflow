"use client";

import { useEffect } from "react";
import { callApi } from "./api";

/** Отварянето на днешния списък се записва като acknowledgement → резервният имейл не се изпраща. */
export function AckOnView() {
  useEffect(() => {
    void callApi("/api/batch/ack", {});
  }, []);
  return null;
}
