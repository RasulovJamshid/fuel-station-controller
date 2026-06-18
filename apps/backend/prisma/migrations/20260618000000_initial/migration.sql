-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'COMPANY_ADMIN', 'STATION_MANAGER', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('COMPLETED', 'STOPPED', 'ABORTED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OilBase" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OilBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "loginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationAccess" (
    "userId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,

    CONSTRAINT "StationAccess_pkey" PRIMARY KEY ("userId","stationId")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "oilBaseId" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "apiKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ipAllowlist" TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "syncLagAlerted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationUptimeEvent" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationUptimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelingPosition" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "addressByte" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FuelingPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nozzle" (
    "positionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Nozzle_pkey" PRIMARY KEY ("positionId","index")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "fpId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "addressByte" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "price" INTEGER NOT NULL DEFAULT 0,
    "nozzleIndex" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "status" "TxStatus" NOT NULL,
    "parentTxId" TEXT,
    "combinedVolume" DOUBLE PRECISION,
    "combinedAmount" BIGINT,
    "shiftId" TEXT,
    "operatorName" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "operatorName" TEXT NOT NULL,
    "shiftName" TEXT,
    "scheduledStart" TEXT,
    "scheduledEnd" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "totalTransactions" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL DEFAULT 0,
    "status" "ShiftStatus" NOT NULL,
    "notes" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftPositionTotal" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "fpId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "transactionsCount" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ShiftPositionTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservoir" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "tankId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Reservoir_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservoirReading" (
    "id" TEXT NOT NULL,
    "reservoirId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "readingAt" TIMESTAMP(3) NOT NULL,
    "volumeLitres" DOUBLE PRECISION NOT NULL,
    "levelMm" DOUBLE PRECISION,
    "temperatureC" DOUBLE PRECISION,
    "waterMm" DOUBLE PRECISION,
    "fillPercent" DOUBLE PRECISION,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservoirReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSetting" (
    "stationId" TEXT NOT NULL,
    "fpId" TEXT NOT NULL,
    "nozzleIndex" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "PriceSetting_pkey" PRIMARY KEY ("stationId","fpId","nozzleIndex")
);

-- CreateTable
CREATE TABLE "PriceChangeLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "fpId" TEXT NOT NULL,
    "nozzleIndex" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "oldPrice" INTEGER NOT NULL,
    "newPrice" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "PriceChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationHealthEvent" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fpId" TEXT,
    "detail" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "stationId" TEXT,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notifyTelegram" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authSecret" TEXT,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "retryLimit" INTEGER NOT NULL DEFAULT 3,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "stationId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedSyncRecord" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedSyncRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_companyId_email_key" ON "User"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "Session"("refreshToken");

-- CreateIndex
CREATE UNIQUE INDEX "Station_apiKey_key" ON "Station"("apiKey");

-- CreateIndex
CREATE INDEX "Transaction_stationId_startedAt_idx" ON "Transaction"("stationId", "startedAt");

-- CreateIndex
CREATE INDEX "Transaction_companyId_startedAt_idx" ON "Transaction"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "Transaction_stationId_productId_startedAt_idx" ON "Transaction"("stationId", "productId", "startedAt");

-- CreateIndex
CREATE INDEX "Transaction_shiftId_idx" ON "Transaction"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "Reservoir_stationId_tankId_key" ON "Reservoir"("stationId", "tankId");

-- CreateIndex
CREATE INDEX "ReservoirReading_stationId_readingAt_idx" ON "ReservoirReading"("stationId", "readingAt");

-- CreateIndex
CREATE INDEX "ReservoirReading_companyId_readingAt_idx" ON "ReservoirReading"("companyId", "readingAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_integrationId_createdAt_idx" ON "WebhookDelivery"("integrationId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcessedSyncRecord_processedAt_idx" ON "ProcessedSyncRecord"("processedAt");

-- AddForeignKey
ALTER TABLE "OilBase" ADD CONSTRAINT "OilBase_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordHistory" ADD CONSTRAINT "PasswordHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAccess" ADD CONSTRAINT "StationAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAccess" ADD CONSTRAINT "StationAccess_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_oilBaseId_fkey" FOREIGN KEY ("oilBaseId") REFERENCES "OilBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationUptimeEvent" ADD CONSTRAINT "StationUptimeEvent_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelingPosition" ADD CONSTRAINT "FuelingPosition_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nozzle" ADD CONSTRAINT "Nozzle_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "FuelingPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPositionTotal" ADD CONSTRAINT "ShiftPositionTotal_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservoir" ADD CONSTRAINT "Reservoir_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservoirReading" ADD CONSTRAINT "ReservoirReading_reservoirId_fkey" FOREIGN KEY ("reservoirId") REFERENCES "Reservoir"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSetting" ADD CONSTRAINT "PriceSetting_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationHealthEvent" ADD CONSTRAINT "StationHealthEvent_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRule" ADD CONSTRAINT "AlertRule_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

