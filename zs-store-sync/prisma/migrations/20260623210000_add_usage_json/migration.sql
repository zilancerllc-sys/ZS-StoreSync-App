-- AlterTable: Add per-type usage JSON column to Subscription
ALTER TABLE "Subscription" ADD COLUMN "usageJson" TEXT NOT NULL DEFAULT '{}';
