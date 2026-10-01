-- 清理孤儿匿名账号：未绑定邮箱、长期不活动的 Supabase 匿名用户。
-- 背景见 docs/adr/0002-supabase-匿名登录身份方案.md 与 docs/adr/0017-清理孤儿匿名账号.md。
--
-- 策略（保留内容、匿名化）：
--   不删除历史消息与房间，只清理 auth.users 中再也无法登回的孤儿匿名账号。
--   profiles.id -> auth.users 已是 ON DELETE CASCADE，删账号会连带删 profiles，
--   再由 profiles 级联清掉 presence / room_members，并把 messages / rooms 的引用置 NULL。

-- 1) messages.sender_id：改为 ON DELETE SET NULL + 列可空。
--    前端 PostgREST 内嵌 profiles!messages_sender_id_fkey 依赖此外键存在，故不能删约束，
--    只能 SET NULL；resolveSender()（src/windows/lounge/chatHistory.ts）已兼容 null，
--    渲染为「已注销用户」。写入侧仍由 RLS 强制 sender_id = auth.uid()，不会写入 null。
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 2) rooms.created_by：同样 SET NULL + 可空，账号被清理后房间保留、创建者置空。
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_created_by_fkey;
ALTER TABLE public.rooms ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3) connection_requests 是临时的加好友 / 入房请求，任一方被清理后即失去意义，
--    随 profiles 删除一并级联清除（原为 NO ACTION，会阻断删除）。
ALTER TABLE public.connection_requests DROP CONSTRAINT IF EXISTS connection_requests_from_id_fkey;
ALTER TABLE public.connection_requests
  ADD CONSTRAINT connection_requests_from_id_fkey
  FOREIGN KEY (from_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.connection_requests DROP CONSTRAINT IF EXISTS connection_requests_to_id_fkey;
ALTER TABLE public.connection_requests
  ADD CONSTRAINT connection_requests_to_id_fkey
  FOREIGN KEY (to_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 4) 清理函数：仅删除「已无任何 session」的匿名账号（= 已退出登录 / session 已失效），
--    且账号创建超过 p_grace_days 天（宽限，避免误删刚创建尚未建立 session 的新账号）。
--    关键：判定只看「该账号还有没有 session」，不看活跃时间——
--    仍持有 session 的休眠匿名账号（电脑长期没开但没退出登录）永不清理，避免误删。
--    退出登录（signOut 默认 global scope）会删除服务器端 session 行，故「零 session」
--    精确等价于「已退出 / session 已失效」。
CREATE OR REPLACE FUNCTION public.cleanup_orphaned_anonymous_users(p_grace_days integer DEFAULT 1)
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

-- 仅供后台调用，撤销所有客户端权限。
REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM anon, authenticated;

-- 5) 定时任务：每天 03:00 UTC 跑一次，1 天宽限。pg_cron 1.6 按 jobname 幂等 upsert。
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'cleanup-orphaned-anonymous-users',
  '0 3 * * *',
  $cron$ SELECT public.cleanup_orphaned_anonymous_users(1); $cron$
);
