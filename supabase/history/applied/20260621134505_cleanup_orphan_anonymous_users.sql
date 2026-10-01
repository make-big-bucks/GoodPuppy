ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_created_by_fkey;

ALTER TABLE public.connection_requests DROP CONSTRAINT IF EXISTS connection_requests_from_id_fkey;
ALTER TABLE public.connection_requests
  ADD CONSTRAINT connection_requests_from_id_fkey
  FOREIGN KEY (from_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.connection_requests DROP CONSTRAINT IF EXISTS connection_requests_to_id_fkey;
ALTER TABLE public.connection_requests
  ADD CONSTRAINT connection_requests_to_id_fkey
  FOREIGN KEY (to_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_anonymous_users(p_inactive_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH doomed AS (
    DELETE FROM auth.users u
    WHERE u.is_anonymous IS TRUE
      AND u.created_at < now() - make_interval(days => p_inactive_days)
      AND NOT EXISTS (
        SELECT 1 FROM auth.sessions s
        WHERE s.user_id = u.id
          AND s.updated_at > now() - make_interval(days => p_inactive_days)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM doomed;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'cleanup-orphaned-anonymous-users',
  '0 3 * * *',
  $cron$ SELECT public.cleanup_orphaned_anonymous_users(7); $cron$
);
