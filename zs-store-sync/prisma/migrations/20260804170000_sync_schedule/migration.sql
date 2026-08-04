-- Recurring automatic syncs.
--
-- nextRunAt doubles as the claim marker: a runner takes a schedule by moving
-- nextRunAt forward in the same UPDATE that checks it is due, so two machines
-- ticking at the same moment cannot both start the run.

CREATE TABLE "SyncSchedule" (
    "id"         TEXT NOT NULL,
    "ownerShop"  TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "dataTypes"  TEXT NOT NULL DEFAULT '',
    "frequency"  TEXT NOT NULL DEFAULT 'daily',
    "hourUtc"    INTEGER NOT NULL DEFAULT 3,
    "dayOfWeek"  INTEGER NOT NULL DEFAULT 1,
    "enabled"    BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt"  TIMESTAMP(3) NOT NULL,
    "lastRunAt"  TIMESTAMP(3),
    "lastJobId"  TEXT,
    "lastError"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncSchedule_pkey" PRIMARY KEY ("id")
);

-- One schedule per pairing: "sync this source into this store" is a single
-- setting, not a list of overlapping ones.
CREATE UNIQUE INDEX "SyncSchedule_ownerShop_sourceShop_key"
    ON "SyncSchedule" ("ownerShop", "sourceShop");

-- The due query runs on every tick.
CREATE INDEX "SyncSchedule_enabled_nextRunAt_idx"
    ON "SyncSchedule" ("enabled", "nextRunAt");

CREATE INDEX "SyncSchedule_ownerShop_idx"
    ON "SyncSchedule" ("ownerShop");
