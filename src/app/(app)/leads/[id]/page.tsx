import Link from "next/link";
import { notFound } from "next/navigation";
import { LeadDetail } from "@/components/LeadDetail";
import { loadLeadDetail } from "@/domain/leadDetail";
import { requirePageOwner } from "@/lib/server";

export const metadata = { title: "Контакт" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageOwner(`/leads/${id}`);
  const d = await loadLeadDetail(ctx.db, id, ctx.mode, ctx.clock.now());
  if (!d) notFound();
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/leads" className="mb-3 inline-block text-sm">
        ← Към базата
      </Link>
      <LeadDetail d={d} mode={ctx.mode} now={ctx.clock.now()} />
    </div>
  );
}
