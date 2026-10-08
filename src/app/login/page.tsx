import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { currentOwner } from "@/lib/server";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Вход" };

function safeNext(n: string | undefined): string {
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/api") ? n : "/today";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  if (await currentOwner()) redirect(safeNext(sp.next));
  const db = await getDb();
  const hasOwner = (await db.user.count()) > 0;
  const mode = getEnv().APP_MODE;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm bg-panel p-5">
        <div className="mb-1 text-lg font-semibold">BDS LeadFlow</div>
        <p className="mb-4 text-sm text-muted">Частна система — само за собственика. {mode === "demo" && <strong className="text-fuchsia-300">ДЕМО режим.</strong>}</p>
        {hasOwner ? (
          <LoginForm next={safeNext(sp.next)} />
        ) : (
          <div role="status" className="text-sm">
            Няма създаден owner акаунт. Регистрация през сайта не съществува. В терминала изпълни:
            <pre className="mt-2 rounded-md border border-line bg-bg p-2 text-xs">npm run owner:create</pre>
          </div>
        )}
      </div>
    </main>
  );
}
