-- 1. 去掉 connection_requests 的唯一约束，允许同一对用户多次建房
ALTER TABLE public.connection_requests
  DROP CONSTRAINT IF EXISTS connection_requests_from_id_to_id_key;

-- 2. 为 room_members 添加 DELETE 策略
CREATE POLICY "room_members_delete" ON public.room_members
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- 3. 私有实现：原子退出并在最后一人时删除房间
CREATE OR REPLACE FUNCTION private.leave_room(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_remaining int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this room';
  END IF;

  UPDATE public.presence
    SET current_room_id = NULL, is_online = false
    WHERE user_id = auth.uid() AND current_room_id = p_room_id;

  DELETE FROM public.room_members
    WHERE room_id = p_room_id AND user_id = auth.uid();

  SELECT COUNT(*) INTO v_remaining
    FROM public.room_members WHERE room_id = p_room_id;

  IF v_remaining = 0 THEN
    DELETE FROM public.rooms WHERE id = p_room_id;
  END IF;
END;
$$;

-- 4. Public wrapper
CREATE OR REPLACE FUNCTION public.leave_room(p_room_id uuid)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.leave_room(p_room_id)
$$;

GRANT EXECUTE ON FUNCTION public.leave_room(uuid) TO authenticated;
