-- Email notifications for scheduled runs.
--
-- A schedule only STARTS a job; the result is known later, when the runner
-- finishes. So the job has to remember which schedule started it — that is
-- what MigrationJob.scheduleId is for. Manual runs leave it null and are never
-- notified about, because the merchant is already looking at the screen.

ALTER TABLE "MigrationJob" ADD COLUMN "scheduleId" TEXT;

-- Where to write to. Captured from Shopify's shop.email when the schedule is
-- saved, and editable, because the store contact address is often not the
-- person who cares about a sync.
ALTER TABLE "SyncSchedule" ADD COLUMN "notifyEmail" TEXT;
ALTER TABLE "SyncSchedule" ADD COLUMN "notify" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "MigrationJob_scheduleId_idx" ON "MigrationJob" ("scheduleId");
