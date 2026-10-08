-- AlterTable
ALTER TABLE "DailyBatchItem" ADD COLUMN "processedActivityId" TEXT;
ALTER TABLE "DailyBatchItem" ADD COLUMN "processedAt" DATETIME;
ALTER TABLE "DailyBatchItem" ADD COLUMN "processedOutcome" TEXT;

-- CreateIndex
CREATE INDEX "DailyBatchItem_processedAt_idx" ON "DailyBatchItem"("processedAt");


-- Попълване: участие в списък е обработено от първия записан резултат (един от деветте) за бизнеса след издаването.
UPDATE "DailyBatchItem" SET
  "processedActivityId" = (SELECT a."id" FROM "Activity" a WHERE a."businessId" = "DailyBatchItem"."businessId" AND a."outcome" IS NOT NULL AND a."occurredAt" >= "DailyBatchItem"."issuedAt" ORDER BY a."occurredAt" ASC, a."id" ASC LIMIT 1)
WHERE "processedAt" IS NULL;
UPDATE "DailyBatchItem" SET
  "processedAt" = (SELECT a."occurredAt" FROM "Activity" a WHERE a."id" = "DailyBatchItem"."processedActivityId"),
  "processedOutcome" = (SELECT a."outcome" FROM "Activity" a WHERE a."id" = "DailyBatchItem"."processedActivityId")
WHERE "processedActivityId" IS NOT NULL AND "processedAt" IS NULL;

-- Потвърдено от собственика: нови списъци само понеделник–петък.
UPDATE "AppSettings" SET "data" = json_set("data", '$.activeWeekdays', json('[1,2,3,4,5]')) WHERE json_valid("data");
