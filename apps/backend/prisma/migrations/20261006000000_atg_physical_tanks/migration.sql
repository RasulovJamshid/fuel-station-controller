ALTER TABLE "Station" ADD COLUMN "tankCatalogUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Reservoir" ADD COLUMN "monitoringEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Reservoir" ADD COLUMN "staleAfterSecs" INTEGER NOT NULL DEFAULT 600;
ALTER TABLE "Reservoir" ADD COLUMN "managedByStation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Reservoir" ADD COLUMN "configUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ReservoirReading" ADD COLUMN "productId" INTEGER;
ALTER TABLE "ReservoirReading" ADD COLUMN "productName" TEXT;
-- Keep the most recently stored copy of each physical sample before enforcing uniqueness.
DELETE FROM "ReservoirReading" WHERE id IN (
 SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY "reservoirId","readingAt" ORDER BY "syncedAt" DESC,id DESC) AS n FROM "ReservoirReading") copies WHERE n > 1
);
CREATE UNIQUE INDEX "ReservoirReading_reservoirId_readingAt_key" ON "ReservoirReading"("reservoirId","readingAt");
CREATE TABLE "StationStockRecord" (
 "id" TEXT NOT NULL, "stationId" TEXT NOT NULL, "companyId" TEXT NOT NULL,
 "entityType" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "tankId" TEXT,
 "productId" INTEGER NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL, "payload" JSONB NOT NULL,
 CONSTRAINT "StationStockRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StationStockRecord_stationId_entityType_sourceId_key" ON "StationStockRecord"("stationId","entityType","sourceId");
CREATE INDEX "StationStockRecord_companyId_stationId_occurredAt_idx" ON "StationStockRecord"("companyId","stationId","occurredAt");
CREATE INDEX "StationStockRecord_stationId_tankId_occurredAt_idx" ON "StationStockRecord"("stationId","tankId","occurredAt");
