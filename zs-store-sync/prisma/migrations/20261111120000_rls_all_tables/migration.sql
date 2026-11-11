-- Supabase flagged AppStoreRank and AppStoreRankTarget (rls_disabled_in_public):
-- the 20261029 migration created them without RLS, so anyone with the project
-- URL and anon key could read and change them through the Data API. The app
-- connects as the table owner, which RLS doesn't restrict, so nothing changes
-- for it. The loop also covers any other public table that slipped through.
ALTER TABLE "AppStoreRank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppStoreRankTarget" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
