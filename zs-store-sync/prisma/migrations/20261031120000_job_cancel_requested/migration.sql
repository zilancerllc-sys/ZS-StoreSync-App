-- Stop button: the runner checks this between items.
ALTER TABLE "MigrationJob" ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false;
