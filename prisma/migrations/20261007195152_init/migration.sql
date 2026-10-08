-- CreateTable
CREATE TABLE "SystemMeta" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "mode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "demoDayOffset" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerSlot" INTEGER NOT NULL DEFAULT 1,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ref" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "normalizedName" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "category" TEXT NOT NULL,
    "phoneRaw" TEXT,
    "phoneNormalized" TEXT,
    "phoneKind" TEXT,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "website" TEXT,
    "websiteDomain" TEXT,
    "socialUrl" TEXT,
    "socialActive" BOOLEAN,
    "mapsUrl" TEXT,
    "contactPersonName" TEXT,
    "contactPersonRole" TEXT,
    "contactPersonSource" TEXT,
    "eik" TEXT,
    "rating" REAL,
    "reviewCount" INTEGER,
    "ratingSource" TEXT,
    "websiteStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "isChain" BOOLEAN,
    "pipelineStage" TEXT NOT NULL DEFAULT 'NEW',
    "lastOutcome" TEXT,
    "lastContactAt" DATETIME,
    "nextAction" TEXT,
    "nextActionAt" DATETIME,
    "firstIssuedAt" DATETIME,
    "contactHistoryState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reviewReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" DATETIME,
    "archivedReason" TEXT,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "sourceUrl" TEXT,
    "sourceUsageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME,
    "verifiedAt" DATETIME,
    "confidence" REAL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "mergedIntoId" TEXT,
    "suggestedService" TEXT,
    "estimatedValueCents" INTEGER,
    "openingLine" TEXT,
    "questions" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Business_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Business" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessIdentifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessIdentifier_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessAId" TEXT NOT NULL,
    "businessBId" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DuplicateCandidate_businessAId_fkey" FOREIGN KEY ("businessAId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DuplicateCandidate_businessBId_fkey" FOREIGN KEY ("businessBId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "fetchedAt" DATETIME NOT NULL,
    "verifiedAt" DATETIME,
    "storageAllowed" BOOLEAN NOT NULL,
    "derivedUseAllowed" BOOLEAN NOT NULL,
    "expiresAt" DATETIME,
    "note" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "SourceEvidence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebsiteAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL,
    "url" TEXT,
    "result" TEXT NOT NULL,
    "https" BOOLEAN,
    "hasViewport" BOOLEAN,
    "contactVisible" BOOLEAN,
    "poorMobile" BOOLEAN,
    "strongModern" BOOLEAN,
    "issues" TEXT NOT NULL DEFAULT '[]',
    "evidence" TEXT NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "WebsiteAudit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "reviewDate" TEXT,
    "url" TEXT,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "BusinessReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreEvaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" TEXT NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoreEvaluation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT,
    "callConnected" BOOLEAN,
    "note" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PipelineHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "reason" TEXT,
    "activityId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineHistory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DailyBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "localDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "target" INTEGER NOT NULL,
    "scheduledAt" DATETIME NOT NULL,
    "publishedAt" DATETIME,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "shortfallReason" TEXT,
    "quotaPlan" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DailyBatchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "scoreAtIssue" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    CONSTRAINT "DailyBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DailyBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DailyBatchItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "activityId" TEXT,
    "offerId" TEXT,
    "kind" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" DATETIME,
    "cancelledReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FollowUp_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowUp_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FollowUp_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "oneTimeCents" INTEGER NOT NULL,
    "monthlyCents" INTEGER,
    "description" TEXT NOT NULL DEFAULT '',
    "offerDate" TEXT NOT NULL,
    "validUntil" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "nextStep" TEXT,
    "sentAt" DATETIME,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Offer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "offerId" TEXT,
    "service" TEXT NOT NULL,
    "agreedOneTimeCents" INTEGER NOT NULL,
    "monthlyCents" INTEGER,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Client_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Client_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReceivedPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedOn" TEXT NOT NULL,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceivedPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "businessId" TEXT,
    "identifierType" TEXT,
    "identifierValue" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" DATETIME,
    "liftedReason" TEXT,
    CONSTRAINT "Suppression_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    "lastFailureAt" DATETIME,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" DATETIME,
    "expiredAt" DATETIME
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupeKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "localDate" TEXT,
    "batchId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notBefore" DATETIME NOT NULL,
    "leaseUntil" DATETIME,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outboxId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    CONSTRAINT "DeliveryAttempt_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "NotificationOutbox" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DailyAcknowledgement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "localDate" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "via" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "lastError" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "counts" TEXT NOT NULL DEFAULT '{}',
    "confirmedUncontacted" BOOLEAN NOT NULL DEFAULT false,
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ImportRowIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    CONSTRAINT "ImportRowIssue_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "Counter" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_ownerSlot_key" ON "User"("ownerSlot");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "LoginAttempt_key_at_idx" ON "LoginAttempt"("key", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Business_ref_key" ON "Business"("ref");

-- CreateIndex
CREATE INDEX "Business_city_category_idx" ON "Business"("city", "category");

-- CreateIndex
CREATE INDEX "Business_pipelineStage_idx" ON "Business"("pipelineStage");

-- CreateIndex
CREATE INDEX "Business_status_idx" ON "Business"("status");

-- CreateIndex
CREATE INDEX "Business_normalizedName_city_idx" ON "Business"("normalizedName", "city");

-- CreateIndex
CREATE INDEX "BusinessIdentifier_type_value_idx" ON "BusinessIdentifier"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessIdentifier_businessId_type_value_key" ON "BusinessIdentifier"("businessId", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateCandidate_businessAId_businessBId_matchType_key" ON "DuplicateCandidate"("businessAId", "businessBId", "matchType");

-- CreateIndex
CREATE INDEX "ScoreEvaluation_businessId_computedAt_idx" ON "ScoreEvaluation"("businessId", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_idempotencyKey_key" ON "Activity"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Activity_businessId_occurredAt_idx" ON "Activity"("businessId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_type_occurredAt_idx" ON "Activity"("type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBatch_localDate_key" ON "DailyBatch"("localDate");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBatchItem_businessId_key" ON "DailyBatchItem"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyBatchItem_batchId_position_key" ON "DailyBatchItem"("batchId", "position");

-- CreateIndex
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Client_businessId_key" ON "Client"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_offerId_key" ON "Client"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivedPayment_idempotencyKey_key" ON "ReceivedPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Suppression_identifierType_identifierValue_idx" ON "Suppression"("identifierType", "identifierValue");

-- CreateIndex
CREATE INDEX "Suppression_businessId_idx" ON "Suppression"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_notBefore_idx" ON "NotificationOutbox"("status", "notBefore");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAcknowledgement_localDate_key" ON "DailyAcknowledgement"("localDate");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_key_key" ON "JobRun"("key");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
