import { notFound } from "next/navigation";
import { CopyText } from "@/components/client/CopyText";
import { money } from "@/components/ui";
import { OFFER_STATUS_LABELS, type OfferStatus } from "@/domain/constants";
import { requirePageOwner } from "@/lib/server";
import { fmtDate } from "@/lib/time";

export const metadata = { title: "Оферта — преглед" };

export default async function OfferPrint({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageOwner(`/offers/${id}/print`);
  const o = await ctx.db.offer.findUnique({ where: { id }, include: { business: { select: { name: true, city: true } } } });
  if (!o) notFound();
  const text = [
    `Оферта за ${o.business.name}`,
    `Услуга: ${o.service}`,
    `Еднократна сума: ${money(o.oneTimeCents)}`,
    `Месечна поддръжка: ${o.monthlyCents !== null ? money(o.monthlyCents) : "не е включена"}`,
    o.description ? `\n${o.description}` : "",
    `\nДата: ${fmtDate(o.offerDate)}${o.validUntil ? ` · Валидна до: ${fmtDate(o.validUntil)}` : ""}`,
    "Bulgaria Digital Services",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="mx-auto max-w-2xl">
      <p className="mb-3 text-sm text-muted print:hidden">
        Статус: {OFFER_STATUS_LABELS[o.status as OfferStatus]}. Копирай текста или отпечатай (Ctrl+P). Приложението не изпраща офертата. <CopyText text={text} />
      </p>
      <pre className="card bg-white p-6 text-sm whitespace-pre-wrap text-black print:border-0">{text}</pre>
    </div>
  );
}
