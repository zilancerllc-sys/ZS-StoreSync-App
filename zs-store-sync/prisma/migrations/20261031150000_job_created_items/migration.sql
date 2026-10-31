-- Undo: ids of what each run created.
ALTER TABLE "MigrationJob" ADD COLUMN "undoOfJobId" TEXT;

CREATE TABLE "JobCreatedItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "gid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobCreatedItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JobCreatedItem_jobId_idx" ON "JobCreatedItem"("jobId");
CREATE INDEX "JobCreatedItem_shop_createdAt_idx" ON "JobCreatedItem"("shop", "createdAt");
CREATE INDEX "JobCreatedItem_shop_gid_idx" ON "JobCreatedItem"("shop", "gid");

ALTER TABLE "JobCreatedItem" ENABLE ROW LEVEL SECURITY;
