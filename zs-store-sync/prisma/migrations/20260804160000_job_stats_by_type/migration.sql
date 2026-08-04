-- Per-data-type breakdown for a migration run.
--
-- MigrationJob only ever stored run totals ("122 created"), so History could
-- list which types were selected but not how each one did. statsJson holds
-- { "products": { "created": 120, "updated": 0, "skipped": 2, "failed": 1 }, … }
--
-- Nullable on purpose: jobs that ran before this column existed keep their
-- totals and the UI falls back to the old summary for them.
ALTER TABLE "MigrationJob" ADD COLUMN "statsJson" TEXT;
