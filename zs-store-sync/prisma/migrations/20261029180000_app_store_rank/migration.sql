-- CreateTable
CREATE TABLE "AppStoreRank" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER,
    "total" INTEGER,
    "rating" DOUBLE PRECISION,
    "reviews" INTEGER,
    "label" TEXT,
    "top" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppStoreRank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppStoreRankTarget" (
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppStoreRankTarget_pkey" PRIMARY KEY ("kind","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppStoreRank_day_kind_key_key" ON "AppStoreRank"("day", "kind", "key");

-- CreateIndex
CREATE INDEX "AppStoreRank_kind_key_idx" ON "AppStoreRank"("kind", "key");
