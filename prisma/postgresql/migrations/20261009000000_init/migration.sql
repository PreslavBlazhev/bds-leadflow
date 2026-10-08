-- BDS LeadFlow — PostgreSQL: начална миграция (отделна история от SQLite; не е превод на SQLite миграциите).
-- Таблиците са генерирани от prisma/postgresql/schema.prisma (prisma migrate diff --from-empty).
-- Отговаря на SQLite състоянието след 20261009000000_production_prep. Времената са TIMESTAMP(3) в UTC (конвенция на Prisma).
-- Парите са INTEGER в евроцентове (както в SQLite); JSON полетата са TEXT, валидирани в кода (Zod).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "SystemMeta" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "demoDayOffset" INTEGER NOT NULL DEFAULT 0,
    "migratedFromArchive" TEXT,
    "migratedAt" TIMESTAMP(3),

    CONSTRAINT "SystemMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "ownerSlot" INTEGER NOT NULL DEFAULT 1,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
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
    "rating" DOUBLE PRECISION,
    "reviewCount" INTEGER,
    "ratingSource" TEXT,
    "websiteStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "isChain" BOOLEAN,
    "pipelineStage" TEXT NOT NULL DEFAULT 'NEW',
    "lastOutcome" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "nextAction" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "firstIssuedAt" TIMESTAMP(3),
    "contactHistoryState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reviewReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" TEXT,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "sourceUrl" TEXT,
    "sourceUsageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "mergedIntoId" TEXT,
    "score" INTEGER,
    "scoreAt" TIMESTAMP(3),
    "suggestedService" TEXT,
    "estimatedValueCents" INTEGER,
    "openingLine" TEXT,
    "questions" TEXT,
    "notes" TEXT,
    "sourceCategory" TEXT,
    "subcategory" TEXT,
    "district" TEXT,
    "phone2Raw" TEXT,
    "phone2Normalized" TEXT,
    "openingHours" TEXT,
    "websiteObservation" TEXT,
    "facebookUrl" TEXT,
    "instagramUrl" TEXT,
    "otherProfileUrl" TEXT,
    "recentReviewNote" TEXT,
    "sourceCheckedOn" TEXT,
    "confidenceLabel" TEXT,
    "callPriority" TEXT,
    "sourceName" TEXT,
    "sourceSheet" TEXT,
    "sourceRowNo" INTEGER,
    "importedAt" TIMESTAMP(3),
    "priorContact" TEXT,
    "priorContactSource" TEXT,
    "priorContactNote" TEXT,
    "priorContactRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessIdentifier" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" TEXT NOT NULL,
    "businessAId" TEXT NOT NULL,
    "businessBId" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEvidence" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "storageAllowed" BOOLEAN NOT NULL,
    "derivedUseAllowed" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SourceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteAudit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
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

    CONSTRAINT "WebsiteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessReview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "reviewDate" TEXT,
    "url" TEXT,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BusinessReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreEvaluation" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT,
    "callConnected" BOOLEAN,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineHistory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "reason" TEXT,
    "activityId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyBatch" (
    "id" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "target" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "late" BOOLEAN NOT NULL DEFAULT false,
    "shortfallReason" TEXT,
    "quotaPlan" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "scoreAtIssue" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processedOutcome" TEXT,
    "processedActivityId" TEXT,

    CONSTRAINT "DailyBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "activityId" TEXT,
    "offerId" TEXT,
    "kind" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
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
    "sentAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "offerId" TEXT,
    "service" TEXT NOT NULL,
    "agreedOneTimeCents" INTEGER NOT NULL,
    "monthlyCents" INTEGER,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "nextAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedPayment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedOn" TEXT NOT NULL,
    "note" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "businessId" TEXT,
    "identifierType" TEXT,
    "identifierValue" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedAt" TIMESTAMP(3),
    "liftedReason" TEXT,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "localDate" TEXT,
    "batchId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "receiptTokenHash" TEXT,
    "swReceivedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAttempt" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,

    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyAcknowledgement" (
    "id" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "via" TEXT NOT NULL,

    CONSTRAINT "DailyAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "host" TEXT,
    "version" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "beatAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "schemaOk" BOOLEAN NOT NULL DEFAULT false,
    "schedulerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deliveriesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "counts" TEXT NOT NULL DEFAULT '{}',
    "confirmedUncontacted" BOOLEAN NOT NULL DEFAULT false,
    "usageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRowIssue" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "ImportRowIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "PilotCandidate" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "matchedBusinessId" TEXT,
    "reviewNote" TEXT,
    "businessId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "PilotCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "Business_sourceName_sourceSheet_sourceRowNo_idx" ON "Business"("sourceName", "sourceSheet", "sourceRowNo");

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
CREATE INDEX "DailyBatchItem_processedAt_idx" ON "DailyBatchItem"("processedAt");

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
CREATE INDEX "WorkerHeartbeat_beatAt_idx" ON "WorkerHeartbeat"("beatAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_key_key" ON "JobRun"("key");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE UNIQUE INDEX "PilotCandidate_placeId_key" ON "PilotCandidate"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "PilotCandidate_businessId_key" ON "PilotCandidate"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiUsage_month_sku_key" ON "ApiUsage"("month", "sku");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessIdentifier" ADD CONSTRAINT "BusinessIdentifier_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_businessAId_fkey" FOREIGN KEY ("businessAId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_businessBId_fkey" FOREIGN KEY ("businessBId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvidence" ADD CONSTRAINT "SourceEvidence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessReview" ADD CONSTRAINT "BusinessReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreEvaluation" ADD CONSTRAINT "ScoreEvaluation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineHistory" ADD CONSTRAINT "PipelineHistory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyBatchItem" ADD CONSTRAINT "DailyBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DailyBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyBatchItem" ADD CONSTRAINT "DailyBatchItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivedPayment" ADD CONSTRAINT "ReceivedPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAttempt" ADD CONSTRAINT "DeliveryAttempt_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "NotificationOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRowIssue" ADD CONSTRAINT "ImportRowIssue_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Допълнителни ограничения (Prisma схемата не ги изразява). Пазят бизнес инвариантите и при
-- конкурентни заявки от web + worker. Стойностите съвпадат с src/domain/constants.ts.
-- ---------------------------------------------------------------------------------------------

-- Едно повторно обаждане („Не отговори“) на записан опит (същият частичен индекс е и в SQLite).
CREATE UNIQUE INDEX "FollowUp_retry_activity_key" ON "FollowUp"("activityId") WHERE "kind" = 'RETRY' AND "activityId" IS NOT NULL;

-- Единични редове.
ALTER TABLE "SystemMeta" ADD CONSTRAINT "SystemMeta_single_row" CHECK ("id" = 1);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_single_row" CHECK ("id" = 1);
ALTER TABLE "SystemMeta" ADD CONSTRAINT "SystemMeta_mode_check" CHECK ("mode" IN ('demo', 'real'));

-- Местна дата на списъка: YYYY-MM-DD (Europe/Sofia), никога timestamp.
ALTER TABLE "DailyBatch" ADD CONSTRAINT "DailyBatch_localDate_format" CHECK ("localDate" ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE "DailyBatchItem" ADD CONSTRAINT "DailyBatchItem_position_positive" CHECK ("position" >= 1);
ALTER TABLE "DailyBatchItem" ADD CONSTRAINT "DailyBatchItem_processed_consistent"
  CHECK (("processedAt" IS NULL AND "processedOutcome" IS NULL) OR ("processedAt" IS NOT NULL AND "processedOutcome" IS NOT NULL));
ALTER TABLE "DailyBatchItem" ADD CONSTRAINT "DailyBatchItem_processedOutcome_check"
  CHECK ("processedOutcome" IS NULL OR "processedOutcome" IN ('NO_ANSWER','SPOKE','CALL_BACK','INTERESTED','SEND_OFFER','WON','DECLINED','INVALID_NUMBER','DO_NOT_CONTACT'));

-- Статуси (вместо enum: стойностите се валидират и в кода; CHECK пази базата от невалидни записи).
ALTER TABLE "Business" ADD CONSTRAINT "Business_status_check" CHECK ("status" IN ('ACTIVE', 'ARCHIVED', 'CLOSED'));
ALTER TABLE "Business" ADD CONSTRAINT "Business_pipelineStage_check" CHECK ("pipelineStage" IN ('NEW','CONTACTED','QUALIFIED','PROPOSAL','WON','LOST'));
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_status_check" CHECK ("status" IN ('OPEN', 'DONE', 'CANCELLED'));
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_kind_check" CHECK ("kind" IN ('RETRY', 'CALL_BACK', 'OFFER', 'NEXT_STEP', 'GENERAL'));
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_type_check" CHECK ("type" IN ('DNC', 'INVALID_PHONE'));
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_channel_check" CHECK ("channel" IN ('PUSH', 'EMAIL'));
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_attempts_check" CHECK ("attempts" >= 0);
