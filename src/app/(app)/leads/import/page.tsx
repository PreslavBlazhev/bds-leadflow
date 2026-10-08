import Link from "next/link";
import { ImportWizard } from "@/components/client/ImportWizard";
import { PageHeader, StateBadge } from "@/components/ui";
import { IMPORT_FIELDS } from "@/domain/csv";
import { requirePageOwner } from "@/lib/server";
import { fmtDateTime } from "@/lib/time";

export const metadata = { title: "Импорт CSV" };

export default async function ImportPage() {
  const ctx = await requirePageOwner("/leads/import");
  const batches = await ctx.db.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { _count: { select: { issues: true } } } });
  return (
    <>
      <Link href="/leads" className="mb-3 inline-block text-sm">
        ← Към базата
      </Link>
      <PageHeader title="Импорт CSV" state={<StateBadge state="WORKING_LOCAL" />} sub="UTF-8 CSV (запетая, точка и запетая или таб). Максимум 2 MB / 5000 реда. Импорт директно от .xlsx още не се поддържа — запиши файла като CSV." />
      <div className="card mb-4 p-3 text-sm">
        <p>
          Импортираните записи по подразбиране са с <strong>неизвестна история</strong> и <strong>не влизат в новите</strong>, докато не потвърдиш историята. Липсваща история ≠ „никога не е звъняно“. Повторен импорт на същия файл не създава
          нови бизнеси/дейности и не нулира DNC.
        </p>
        <p className="mt-2 text-muted">Разпознати колони: {IMPORT_FIELDS.join(", ")}.</p>
        <a href="/api/import/sample" className="btn btn-sm mt-2" download data-noguard>
          Изтегли примерен CSV
        </a>
      </div>
      <ImportWizard fields={[...IMPORT_FIELDS]} />
      <h2 className="mt-6 mb-2 text-base font-semibold">Последни импорти</h2>
      {batches.length === 0 ? (
        <p className="text-sm text-muted">Няма импорти.</p>
      ) : (
        <table className="data card">
          <thead>
            <tr>
              <th>Файл</th>
              <th>Дата</th>
              <th>Резултат</th>
              <th>Потвърдено неконтактувани</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const c = JSON.parse(b.counts) as Record<string, number>;
              return (
                <tr key={b.id}>
                  <td>{b.filename}</td>
                  <td>{fmtDateTime(b.createdAt)}</td>
                  <td className="text-xs">
                    създадени {c.created ?? 0} · дубликати {c.duplicate ?? 0} · конфликти {c.conflict ?? 0} · пропуснати {c.skipped ?? 0}
                  </td>
                  <td>{b.confirmedUncontacted ? "Да (audit)" : "Не"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
