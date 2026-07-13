CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StationProductMapping" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stationProductId" INTEGER,
    "stationProductName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StationProductMapping_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Transaction" ADD COLUMN "canonicalProductId" TEXT;
ALTER TABLE "PriceSetting" ADD COLUMN "canonicalProductId" TEXT;

CREATE UNIQUE INDEX "Product_companyId_code_key" ON "Product"("companyId", "code");
CREATE INDEX "Product_companyId_name_idx" ON "Product"("companyId", "name");
CREATE UNIQUE INDEX "StationProductMapping_stationId_normalizedName_key" ON "StationProductMapping"("stationId", "normalizedName");
CREATE INDEX "StationProductMapping_stationId_stationProductId_idx" ON "StationProductMapping"("stationId", "stationProductId");
CREATE INDEX "StationProductMapping_companyId_productId_idx" ON "StationProductMapping"("companyId", "productId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StationProductMapping" ADD CONSTRAINT "StationProductMapping_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StationProductMapping" ADD CONSTRAINT "StationProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PriceSetting" ADD CONSTRAINT "PriceSetting_canonicalProductId_fkey" FOREIGN KEY ("canonicalProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
