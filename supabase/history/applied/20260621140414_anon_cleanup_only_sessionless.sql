DROP FUNCTION IF EXISTS public.cleanup_orphaned_anonymous_users(integer);

-- 仅清理「已无任何 session」的匿名账号（= 已退出登录 / session 已失效），
-- 且账号创建超过 p_grace_days 天（宽限，避免误删刚创建尚未建立 session 的新账号）。
-- 仍持有 session 的休眠匿名账号永不清理。
CREATE FUNCTION public.cleanup_orphaned_anonymous_users(p_grace_days integer DEFAULT 1)
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
      AND u.created_at < now() - make_interval(days => p_grace_days)
      AND NOT EXISTS (
        SELECT 1 FROM auth.sessions s WHERE s.user_id = u.id
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM doomed;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM anon, authenticated;

SELECT cron.schedule(
  'cleanup-orphaned-anonymous-users',
  '0 3 * * *',
  $cron$ SELECT public.cleanup_orphaned_anonymous_users(1); $cron$
);
