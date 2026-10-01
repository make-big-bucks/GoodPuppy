-- 1. 给 connection_requests 加 room_id（可空，指向已存在房间）
ALTER TABLE public.connection_requests
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.rooms(id) ON DELETE SET NULL;

-- 2. 更新 private.accept_connection：
--    - 若 room_id 非空 → 将 to_id 加入已有房间
--    - 若 room_id 为空 → 保持原行为（建新 1:1 房间）
CREATE OR REPLACE FUNCTION private.accept_connection(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from_id  uuid;
  v_to_id    uuid;
  v_room_id  uuid;
  v_req_room uuid;
BEGIN
  -- 验证：请求存在、当前用户是接收方、状态为 pending
  SELECT from_id, to_id, room_id
  INTO v_from_id, v_to_id, v_req_room
  FROM public.connection_requests
  WHERE id = p_request_id
    AND to_id = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or unauthorized connection request';
  END IF;

  -- 改状态
  UPDATE public.connection_requests SET status = 'accepted' WHERE id = p_request_id;

  IF v_req_room IS NOT NULL THEN
    -- 邀请加入已有房间：将双方都加入（幂等）
    INSERT INTO public.room_members (room_id, user_id) VALUES
      (v_req_room, v_from_id),
      (v_req_room, v_to_id)
    ON CONFLICT DO NOTHING;
    RETURN v_req_room;
  ELSE
    -- 原行为：建新 1:1 房间并加入双方
    INSERT INTO public.rooms (created_by)
    VALUES (auth.uid())
    RETURNING id INTO v_room_id;

    INSERT INTO public.room_members (room_id, user_id) VALUES
      (v_room_id, v_from_id),
      (v_room_id, v_to_id);

    RETURN v_room_id;
  END IF;
END;
$$;

-- 3. 开启 room_members 的 Realtime（让邀请方实时感知新成员加入）
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;
