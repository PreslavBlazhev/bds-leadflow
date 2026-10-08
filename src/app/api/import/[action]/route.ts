import { NextResponse } from "next/server";
import { z } from "zod";
import { commitImport, previewImport, SAMPLE_CSV, type commitInput, type Mapping } from "@/domain/csv";
import { DomainError } from "@/domain/errors";
import { jsonBody } from "@/lib/body";
import { api } from "@/lib/server";

export const POST = api(async (ctx, req, p) => {
  const b = await jsonBody(req, 2_500_000);
  if (p.action === "preview") {
    const v = z.object({ text: z.string().min(1), mapping: z.record(z.string(), z.string()).optional() }).parse(b);
    return previewImport(ctx, v.text, v.mapping as Mapping | undefined);
  }
  if (p.action === "commit") return commitImport(ctx, b as z.input<typeof commitInput>);
  throw new DomainError("NOT_FOUND", "Непознато действие.");
});

export const GET = api(async (_ctx, _req, p) => {
  if (p.action !== "sample") throw new DomainError("NOT_FOUND", "Непознато действие.");
  return new NextResponse(SAMPLE_CSV, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="leadflow-sample.csv"', "cache-control": "no-store" },
  });
});
