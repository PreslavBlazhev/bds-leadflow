-- Подготовка за production: heartbeat на worker-а, разписки за push, отбелязване на пренос между бази.
-- Само добавя колони/таблица/индекс — съществуващите данни не се променят.
-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN "openedAt" DATETIME;
ALTER TABLE "NotificationOutbox" ADD COLUMN "receiptTokenHash" TEXT;
ALTER TABLE "NotificationOutbox" ADD COLUMN "swReceivedAt" DATETIME;

-- AlterTable
ALTER TABLE "SystemMeta" ADD COLUMN "migratedAt" DATETIME;
ALTER TABLE "SystemMeta" ADD COLUMN "migratedFromArchive" TEXT;

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT,
    "version" TEXT,
    "startedAt" DATETIME NOT NULL,
    "beatAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    "schemaOk" BOOLEAN NOT NULL DEFAULT false,
    "schedulerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deliveriesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessAt" DATETIME,
    "nextCheckAt" DATETIME,
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "stoppedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_beatAt_idx" ON "WorkerHeartbeat"("beatAt");


-- Едно повторно обаждане („Не отговори“) на записан опит: дублиран запис/конкурентна заявка не създава втора задача.
-- Частичен unique индекс (не се изразява в Prisma схемата; същият индекс е и в PostgreSQL миграциите).
CREATE UNIQUE INDEX "FollowUp_retry_activity_key" ON "FollowUp"("activityId") WHERE "kind" = 'RETRY' AND "activityId" IS NOT NULL;
