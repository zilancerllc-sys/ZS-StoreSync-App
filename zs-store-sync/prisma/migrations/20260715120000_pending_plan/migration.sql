-- Scheduled downgrades: plan to apply when the current billing period ends.
ALTER TABLE "Subscription" ADD COLUMN "pendingPlan" TEXT;
