-- =====================================================
-- 辅助函数：获取当前用户所在的所有 room_id
-- SECURITY DEFINER 避免 RLS 递归查询
-- =====================================================
CREATE OR REPLACE FUNCTION get_my_room_ids()
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT room_id FROM room_members WHERE user_id = auth.uid()
$$;

-- =====================================================
-- gp_id 生成：取 uuid 前 8 位十六进制，前缀 gp_
-- =====================================================
CREATE OR REPLACE FUNCTION generate_gp_id(p_user_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'gp_' || left(replace(p_user_id::text, '-', ''), 8)
$$;

CREATE OR REPLACE FUNCTION set_profile_gp_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gp_id IS NULL OR NEW.gp_id = '' THEN
    NEW.gp_id := generate_gp_id(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_gp_id
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION set_profile_gp_id();

-- =====================================================
-- invite_code 生成：8 位随机小写字母+数字
-- =====================================================
CREATE OR REPLACE FUNCTION generate_invite_code()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  chars  text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  result text := '';
  i      int;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION set_room_invite_code()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invite_code IS NULL OR NEW.invite_code = '' THEN
    NEW.invite_code := generate_invite_code();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rooms_set_invite_code
  BEFORE INSERT ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION set_room_invite_code();

-- =====================================================
-- RPC：接受连接请求（原子操作）
-- 改状态 → 建房间 → 加双方为成员
-- =====================================================
CREATE OR REPLACE FUNCTION accept_connection(p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_from_id uuid;
  v_to_id   uuid;
  v_room_id uuid;
BEGIN
  SELECT from_id, to_id INTO v_from_id, v_to_id
  FROM connection_requests
  WHERE id = p_request_id
    AND to_id = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or unauthorized connection request';
  END IF;

  UPDATE connection_requests SET status = 'accepted' WHERE id = p_request_id;

  INSERT INTO rooms (created_by, invite_code)
  VALUES (auth.uid(), generate_invite_code())
  RETURNING id INTO v_room_id;

  INSERT INTO room_members (room_id, user_id) VALUES
    (v_room_id, v_from_id),
    (v_room_id, v_to_id);

  RETURN v_room_id;
END;
$$;

-- =====================================================
-- RPC：按邀请码加入房间
-- =====================================================
CREATE OR REPLACE FUNCTION join_room_by_invite(p_invite_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_room_id uuid;
BEGIN
  SELECT id INTO v_room_id FROM rooms WHERE invite_code = p_invite_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;

  INSERT INTO room_members (room_id, user_id)
  VALUES (v_room_id, auth.uid())
  ON CONFLICT DO NOTHING;

  RETURN v_room_id;
END;
$$;

-- =====================================================
-- RLS：启用并配置各表的访问策略
-- =====================================================

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- rooms
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rooms_select" ON public.rooms
  FOR SELECT TO authenticated USING (id IN (SELECT get_my_room_ids()));
CREATE POLICY "rooms_insert" ON public.rooms
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());

-- room_members
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "room_members_select" ON public.room_members
  FOR SELECT TO authenticated USING (room_id IN (SELECT get_my_room_ids()));
CREATE POLICY "room_members_insert" ON public.room_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- connection_requests
ALTER TABLE public.connection_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "connection_requests_select" ON public.connection_requests
  FOR SELECT TO authenticated USING (from_id = auth.uid() OR to_id = auth.uid());
CREATE POLICY "connection_requests_insert" ON public.connection_requests
  FOR INSERT TO authenticated WITH CHECK (from_id = auth.uid() AND to_id <> auth.uid());
CREATE POLICY "connection_requests_update" ON public.connection_requests
  FOR UPDATE TO authenticated USING (to_id = auth.uid());

-- messages
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_select" ON public.messages
  FOR SELECT TO authenticated USING (room_id IN (SELECT get_my_room_ids()));
CREATE POLICY "messages_insert" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND room_id IN (SELECT get_my_room_ids()));

-- presence
ALTER TABLE public.presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "presence_select" ON public.presence
  FOR SELECT TO authenticated USING (room_id IN (SELECT get_my_room_ids()));
CREATE POLICY "presence_insert" ON public.presence
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND room_id IN (SELECT get_my_room_ids()));
CREATE POLICY "presence_update" ON public.presence
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND room_id IN (SELECT get_my_room_ids()));

-- =====================================================
-- Realtime：开启 messages、presence、connection_requests 的实时订阅
-- =====================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.presence;
ALTER PUBLICATION supabase_realtime ADD TABLE public.connection_requests;
