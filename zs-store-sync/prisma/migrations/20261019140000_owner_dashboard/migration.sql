-- Owner dashboard: install/uninstall event log, the owner's per-store notes,
-- and when a review request went out.
ALTER TABLE "MerchantContact" ADD COLUMN "reviewAskSentAt" TIMESTAMP(3);

CREATE TABLE "AppEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AppEvent_createdAt_idx" ON "AppEvent"("createdAt");
CREATE INDEX "AppEvent_shop_idx" ON "AppEvent"("shop");

CREATE TABLE "StoreMeta" (
    "shop" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "storeName" TEXT,
    "storePlan" TEXT,
    "storeState" TEXT,
    "checkedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreMeta_pkey" PRIMARY KEY ("shop")
);

-- Seed the log from what is still known: every contact's install, and the
-- uninstall of those not yet redacted. The chart is exact from here on.
INSERT INTO "AppEvent" ("id", "shop", "type", "createdAt")
  SELECT 'seed-i-' || "id", "shop", 'install', "installedAt" FROM "MerchantContact";
INSERT INTO "AppEvent" ("id", "shop", "type", "createdAt")
  SELECT 'seed-u-' || "id", "shop", 'uninstall', "uninstalledAt" FROM "MerchantContact" WHERE "uninstalledAt" IS NOT NULL;

-- Same as every other table here: keep the Supabase anon/authenticated roles
-- out (Prisma connects as the owner and is unaffected). See 20260909000000_enable_rls.
ALTER TABLE "AppEvent"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreMeta" ENABLE ROW LEVEL SECURITY;
