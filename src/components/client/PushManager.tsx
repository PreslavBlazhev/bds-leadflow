"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActionButton } from "./ActionButton";
import { callApi } from "./api";

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Support = "unsupported" | "insecure" | "default" | "granted" | "denied";

const noopSubscribe = () => () => {};
function detectSupport(): Support {
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return Notification.permission as Support;
}

/** Permission prompt САМО след директно натискане на „Активирай известията“ (изискване на iOS/Safari и Chrome). */
export function PushManager({ vapidPublicKey, demo = true }: { vapidPublicKey: string | null; demo?: boolean }) {
  const router = useRouter();
  const envSupport = useSyncExternalStore(noopSubscribe, detectSupport, () => null);
  const [permOverride, setSupport] = useState<Support | null>(null);
  const support = permOverride ?? envSupport;
  const [subscribed, setSubscribed] = useState(false);
  /** Абонаментът в браузъра е регистриран и активен в сървъра (този origin/база). null = непроверено. */
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ios = typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent) && !(navigator as Navigator & { standalone?: boolean }).standalone;

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration("/").then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(!!sub);
      if (sub) {
        const r = await callApi("/api/push/check", { endpoint: sub.endpoint });
        setRegistered(r.ok ? !!(r.data as { active?: boolean }).active : null);
      }
    });
  }, []);

  const label = {
    unsupported: "Браузърът не поддържа Web Push.",
    insecure: "Не е secure context (нужен е HTTPS или localhost).",
    default: "Разрешение: не е питано.",
    granted: "Разрешение: дадено.",
    denied: "Разрешение: отказано (промени го от настройките на браузъра).",
  };
  const reason = !vapidPublicKey ? "липсва NEXT_PUBLIC_VAPID_PUBLIC_KEY" : support === "unsupported" || support === "insecure" ? label[support] : support === "denied" ? "разрешението е отказано" : null;

  return (
    <div className="space-y-2 text-sm">
      <p>
        Статус: {support ? label[support] : "проверка…"} {subscribed && registered !== false && "Това устройство е абонирано."}
      </p>
      {subscribed && registered === false && (
        <p className="text-warn">Браузърът има абонамент, но той не е активен за този адрес/база (напр. след преместване на нов HTTPS адрес или изтекъл абонамент). Натисни „Активирай известията“.</p>
      )}
      {ios && <p className="text-xs text-muted">iPhone/iPad: известията работят само след „Добави към началния екран“ (iOS 16.4+) и отваряне оттам.</p>}
      <div className="flex flex-wrap gap-2">
        {reason ? (
          <span className="flex flex-col">
            <button type="button" className="btn btn-sm" disabled>
              Активирай известията
            </button>
            <span className="text-xs text-muted">Недостъпно: {reason}</span>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={async () => {
              setMsg(null);
              try {
                const perm = await Notification.requestPermission();
                setSupport(perm as Support);
                if (perm !== "granted") return setMsg("Разрешението не е дадено.");
                const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
                await navigator.serviceWorker.ready;
                const key = urlB64ToUint8Array(vapidPublicKey!);
                let sub = await reg.pushManager.getSubscription();
                // Сменен VAPID ключ → старият абонамент не може да получава; заменя се.
                const oldKey = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
                if (sub && oldKey && (oldKey.length !== key.length || oldKey.some((b, i) => b !== key[i]))) {
                  await sub.unsubscribe();
                  sub = null;
                }
                sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
                const j = sub.toJSON();
                const r = await callApi("/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys, label: navigator.userAgent.includes("Mobile") ? "Телефон" : "Компютър (браузър)" });
                if (!r.ok) return setMsg(r.error ?? "Грешка при регистрация.");
                setSubscribed(true);
                setRegistered(true);
                setMsg(demo ? "Устройството е регистрирано. В DEMO доставките остават previews." : "Устройството е регистрирано. Провери с „Изпрати реален тестов push“ (ако е разрешено).");
                router.refresh();
              } catch (e) {
                setMsg(`Неуспешно: ${e instanceof Error ? e.message : "грешка"}`);
              }
            }}
          >
            Активирай известията
          </button>
        )}
        {subscribed && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              const reg = await navigator.serviceWorker.getRegistration("/");
              const sub = await reg?.pushManager.getSubscription();
              if (sub) {
                await callApi("/api/push/revoke", { endpoint: sub.endpoint });
                await sub.unsubscribe();
              }
              setSubscribed(false);
              setMsg("Абонаментът е премахнат.");
              router.refresh();
            }}
          >
            Изключи на това устройство
          </button>
        )}
      </div>
      {msg && <p role="status">{msg}</p>}
    </div>
  );
}

export function RevokeDevice({ id }: { id: string }) {
  return (
    <ActionButton url="/api/push/revoke" body={{ id }} className="btn btn-sm">
      Премахни
    </ActionButton>
  );
}

export function TestNotificationButtons({ pushReason, emailReason, demo }: { pushReason: string | null; emailReason: string | null; demo: boolean }) {
  return (
    <div className="flex flex-wrap gap-3">
      <ActionButton url="/api/notifications/test" body={{ channel: "PUSH" }} disabledReason={pushReason} resultText={(d) => (d as { note: string }).note}>
        {demo ? "Тестов push (локален preview)" : "Изпрати реален тестов push"}
      </ActionButton>
      <ActionButton url="/api/notifications/test" body={{ channel: "EMAIL" }} disabledReason={emailReason} resultText={(d) => (d as { note: string }).note}>
        {demo ? "Тестов имейл (локален preview)" : "Изпрати реален тестов имейл"}
      </ActionButton>
    </div>
  );
}
