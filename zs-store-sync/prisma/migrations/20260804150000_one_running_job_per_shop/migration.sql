-- Enforce "one running migration per shop" in the database.
--
-- The application checked getActiveJob() and then created the row, which is a
-- time-of-check-to-time-of-use race: two submits (two tabs, a double click, or
-- a retry) could both pass the check and start two concurrent runs against the
-- same store — duplicating work and double-spending quota.
--
-- A partial unique index makes the second insert fail instead. Prisma's schema
-- language cannot express a partial index, so this migration is hand-written;
-- schema.prisma carries a note so the index is not mistaken for drift.

-- Defensive: the index cannot be created while duplicates exist. Keep the most
-- recent running job per shop and retire the rest. Expected to affect 0 rows.
UPDATE "MigrationJob"
SET status = 'failed',
    "finishedAt" = NOW(),
    error = 'Superseded — another run for this store was already in progress.'
WHERE status = 'running'
  AND id NOT IN (
    SELECT DISTINCT ON (shop) id
    FROM "MigrationJob"
    WHERE status = 'running'
    ORDER BY shop, "createdAt" DESC
  );

CREATE UNIQUE INDEX "MigrationJob_one_running_per_shop"
  ON "MigrationJob" ("shop")
  WHERE status = 'running';
