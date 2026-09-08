ALTER TABLE "Station"
ADD COLUMN "serviceConfig" JSONB,
ADD COLUMN "serviceConfigVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "serviceConfigUpdatedAt" TIMESTAMP(3),
ADD COLUMN "serviceConfigBackup" JSONB,
ADD COLUMN "serviceConfigBackupVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "serviceConfigBackupUpdatedAt" TIMESTAMP(3);
