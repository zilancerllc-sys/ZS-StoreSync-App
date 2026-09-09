-- Enable Row Level Security on all app tables.
-- Prisma connects as the postgres superuser which bypasses RLS, so this
-- does not affect the app. It closes off the Supabase anon/authenticated
-- roles from reading any data directly via the Supabase API.
ALTER TABLE "Session"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MigrationJob"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SyncSchedule"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MerchantContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopSecret"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Feedback"        ENABLE ROW LEVEL SECURITY;
