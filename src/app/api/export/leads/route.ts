import { NextResponse } from "next/server";
import { exportLeadsCsv } from "@/domain/csv";
import { localDateOf } from "@/lib/time";
import { api } from "@/lib/server";

/** Защитен export (само собствени CRM данни, formula-injection safe, UTF-8 BOM за Excel). */
export const GET = api(async (ctx) => {
  const csv = await exportLeadsCsv(ctx);
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leadflow-${ctx.mode}-${localDateOf(ctx.clock.now())}.csv"`,
      "cache-control": "no-store",
    },
  });
});
