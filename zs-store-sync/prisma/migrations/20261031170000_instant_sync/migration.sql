-- Instant sync: per-source switch and the queue of changed products.
ALTER TABLE "StoreConnection" ADD COLUMN "instantSync" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "StoreConnection_sourceShop_instantSync_idx" ON "StoreConnection"("sourceShop", "instantSync");

CREATE TABLE "PendingProductSync" (
    "id" TEXT NOT NULL,
    "ownerShop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingProductSync_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingProductSync_ownerShop_sourceShop_productId_key" ON "PendingProductSync"("ownerShop", "sourceShop", "productId");
CREATE INDEX "PendingProductSync_createdAt_idx" ON "PendingProductSync"("createdAt");

ALTER TABLE "PendingProductSync" ENABLE ROW LEVEL SECURITY;
