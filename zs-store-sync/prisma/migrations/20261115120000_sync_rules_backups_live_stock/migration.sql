-- Price rules per pairing, restore runs, backups before sync, live stock sync.
ALTER TABLE "StoreConnection" ADD COLUMN "priceRuleJson" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "restoreOfJobId" TEXT;

CREATE TABLE "SyncBackup" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "gid" TEXT NOT NULL,
    "label" TEXT,
    "data" BYTEA NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncBackup_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SyncBackup_jobId_idx" ON "SyncBackup"("jobId");
CREATE INDEX "SyncBackup_shop_createdAt_idx" ON "SyncBackup"("shop", "createdAt");

CREATE TABLE "LiveInventorySync" (
    "id" TEXT NOT NULL,
    "ownerShop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "locationMapJson" TEXT NOT NULL DEFAULT '{}',
    "maxZeroPerBatch" INTEGER NOT NULL DEFAULT 20,
    "maxUnitChange" INTEGER NOT NULL DEFAULT 1000,
    "pausedAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSummary" TEXT,
    "activityJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveInventorySync_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveInventorySync_ownerShop_sourceShop_key" ON "LiveInventorySync"("ownerShop", "sourceShop");
CREATE INDEX "LiveInventorySync_sourceShop_enabled_idx" ON "LiveInventorySync"("sourceShop", "enabled");

CREATE TABLE "PendingInventorySync" (
    "id" TEXT NOT NULL,
    "ownerShop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingInventorySync_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingInventorySync_ownerShop_sourceShop_inventoryItemId_key" ON "PendingInventorySync"("ownerShop", "sourceShop", "inventoryItemId");
CREATE INDEX "PendingInventorySync_createdAt_idx" ON "PendingInventorySync"("createdAt");

ALTER TABLE "SyncBackup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LiveInventorySync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PendingInventorySync" ENABLE ROW LEVEL SECURITY;
