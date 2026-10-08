"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NAV } from "../nav-items";
import { callApi } from "./api";


const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

export function SideNav({ counts }: { counts: Record<string, number | undefined> }) {
  const path = usePathname();
  return (
    <nav aria-label="Основна навигация" className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(path, n.href) ? "page" : undefined}
          className={`flex items-center justify-between rounded-md px-3 py-2 text-sm no-underline ${isActive(path, n.href) ? "bg-card text-fg ring-1 ring-line" : "text-muted hover:bg-card hover:text-fg"}`}
        >
          <span>{n.label}</span>
          {counts[n.href] !== undefined && <span className="tabular text-xs text-muted">{counts[n.href]}</span>}
        </Link>
      ))}
    </nav>
  );
}

const BOTTOM = [
  { href: "/today", label: "Днес" },
  { href: "/calls", label: "Обаждания" },
  { href: "/follow-ups", label: "Последващи" },
  { href: "/more", label: "Още" },
];

export function BottomNav({ followUps }: { followUps?: number }) {
  const path = usePathname();
  const more = !["/today", "/calls", "/follow-ups"].some((h) => isActive(path, h));
  return (
    <nav aria-label="Долна навигация" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-panel md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {BOTTOM.map((b) => {
        const active = b.href === "/more" ? more : isActive(path, b.href);
        return (
          <Link key={b.href} href={b.href} aria-current={active ? "page" : undefined} className={`flex min-h-14 flex-col items-center justify-center text-xs no-underline ${active ? "text-accent-2" : "text-muted"}`}>
            <span className={`mb-0.5 h-1 w-6 rounded-full ${active ? "bg-accent" : "bg-transparent"}`} aria-hidden />
            {b.label}
            {b.href === "/follow-ups" && followUps ? <span className="tabular text-[11px]">({followUps})</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        await callApi("/api/auth/logout", {});
        // Изчистване на кешове на service worker-а при изход (той не кешира CRM, но за всеки случай).
        if ("caches" in window) for (const k of await caches.keys()) if (k !== "lf-shell-v1") await caches.delete(k);
        router.replace("/login");
        router.refresh();
      }}
    >
      Изход
    </button>
  );
}
