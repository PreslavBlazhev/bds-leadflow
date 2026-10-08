import Link from "next/link";
import { NAV } from "@/components/nav-items";
import { PageHeader } from "@/components/ui";
import { requirePageOwner } from "@/lib/server";

export const metadata = { title: "Още" };

export default async function MorePage() {
  await requirePageOwner("/more");
  return (
    <>
      <PageHeader title="Още" />
      <ul className="card divide-y divide-line">
        {NAV.map((n) => (
          <li key={n.href}>
            <Link href={n.href} className="flex min-h-12 items-center px-4 text-fg no-underline">
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
