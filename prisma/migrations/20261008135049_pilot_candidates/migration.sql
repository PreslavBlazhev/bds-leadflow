-- CreateTable
CREATE TABLE "PilotCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "placeId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "matchedBusinessId" TEXT,
    "reviewNote" TEXT,
    "businessId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "month" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "PilotCandidate_placeId_key" ON "PilotCandidate"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "PilotCandidate_businessId_key" ON "PilotCandidate"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiUsage_month_sku_key" ON "ApiUsage"("month", "sku");
