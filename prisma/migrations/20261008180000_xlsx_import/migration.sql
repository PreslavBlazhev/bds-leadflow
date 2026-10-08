-- AlterTable
ALTER TABLE "Business" ADD COLUMN "callPriority" TEXT;
ALTER TABLE "Business" ADD COLUMN "confidenceLabel" TEXT;
ALTER TABLE "Business" ADD COLUMN "district" TEXT;
ALTER TABLE "Business" ADD COLUMN "facebookUrl" TEXT;
ALTER TABLE "Business" ADD COLUMN "importedAt" DATETIME;
ALTER TABLE "Business" ADD COLUMN "instagramUrl" TEXT;
ALTER TABLE "Business" ADD COLUMN "openingHours" TEXT;
ALTER TABLE "Business" ADD COLUMN "otherProfileUrl" TEXT;
ALTER TABLE "Business" ADD COLUMN "phone2Normalized" TEXT;
ALTER TABLE "Business" ADD COLUMN "phone2Raw" TEXT;
ALTER TABLE "Business" ADD COLUMN "priorContact" TEXT;
ALTER TABLE "Business" ADD COLUMN "priorContactNote" TEXT;
ALTER TABLE "Business" ADD COLUMN "priorContactRecordedAt" DATETIME;
ALTER TABLE "Business" ADD COLUMN "priorContactSource" TEXT;
ALTER TABLE "Business" ADD COLUMN "recentReviewNote" TEXT;
ALTER TABLE "Business" ADD COLUMN "sourceCategory" TEXT;
ALTER TABLE "Business" ADD COLUMN "sourceCheckedOn" TEXT;
ALTER TABLE "Business" ADD COLUMN "sourceName" TEXT;
ALTER TABLE "Business" ADD COLUMN "sourceRowNo" INTEGER;
ALTER TABLE "Business" ADD COLUMN "sourceSheet" TEXT;
ALTER TABLE "Business" ADD COLUMN "subcategory" TEXT;
ALTER TABLE "Business" ADD COLUMN "websiteObservation" TEXT;

-- CreateIndex
CREATE INDEX "Business_sourceName_sourceSheet_sourceRowNo_idx" ON "Business"("sourceName", "sourceSheet", "sourceRowNo");

