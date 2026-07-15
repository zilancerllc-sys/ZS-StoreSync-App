-- Plan-period lock: paid plans are committed until the current billing period ends.
ALTER TABLE "Subscription" ADD COLUMN "interval" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "Subscription" ADD COLUMN "lockedUntil" TIMESTAMP(3);
