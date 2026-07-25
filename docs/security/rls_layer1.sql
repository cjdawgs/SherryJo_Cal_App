-- Layer-1 Row Level Security for SherryJo_Cal_App.
--
-- Run in the Supabase SQL editor (or psql as the schema owner) if you are not
-- applying `alembic upgrade head`. Idempotent and safe to re-run.
--
-- Effect: the public data API (PostgREST, anon key) can no longer read or write
-- any application table. The backend connects as the table owner and bypasses
-- RLS, so the running application is unaffected.

ALTER TABLE public.users                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.date_sticky_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_tag_color_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tv_diag_log              ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- Verification: every row must report rowsecurity = true.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
