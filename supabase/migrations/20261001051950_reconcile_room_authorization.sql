ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS room_name text;
ALTER TABLE public.connection_requests DROP CONSTRAINT IF EXISTS connection_requests_from_id_to_id_key;

-- 前向修复：建房/加入/邀请共享房间行锁；客户端不能直接添加任意成员。
CREATE OR REPLACE FUNCTION private.create_room(p_room_name text, p_room_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid(); v_creator uuid;
BEGIN
  IF v_user IS NULL OR nullif(btrim(p_room_name), '') IS NULL THEN RAISE EXCEPTION 'Authenticated user and room name required'; END IF;
  INSERT INTO public.rooms(id, room_name, created_by) VALUES(p_room_id, btrim(p_room_name), v_user) ON CONFLICT(id) DO NOTHING;
  SELECT created_by INTO v_creator FROM public.rooms WHERE id=p_room_id FOR UPDATE;
  IF v_creator IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Unauthorized room identity'; END IF;
  INSERT INTO public.room_members(room_id,user_id) VALUES(p_room_id,v_user) ON CONFLICT DO NOTHING;
  RETURN p_room_id;
END $$;
CREATE OR REPLACE FUNCTION public.create_room(p_room_name text, p_room_id uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT private.create_room(p_room_name,p_room_id) $$;

CREATE OR REPLACE FUNCTION private.join_room_by_invite(p_invite_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_room uuid; v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id INTO v_room FROM public.rooms WHERE invite_code=p_invite_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid invite code'; END IF;
  INSERT INTO public.room_members(room_id,user_id) VALUES(v_room,v_user) ON CONFLICT DO NOTHING;
  RETURN v_room;
END $$;

CREATE OR REPLACE FUNCTION private.invite_room_member(p_room_id uuid,p_to_user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid(); v_request uuid;
BEGIN
  PERFORM 1 FROM public.rooms WHERE id=p_room_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id AND user_id=v_user) THEN RAISE EXCEPTION 'Not a room member'; END IF;
  IF p_to_user_id=v_user OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_to_user_id) THEN RAISE EXCEPTION 'Invalid invitation recipient'; END IF;
  IF EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id AND user_id=p_to_user_id) THEN RAISE EXCEPTION 'Already a room member'; END IF;
  SELECT id INTO v_request FROM public.connection_requests WHERE room_id=p_room_id AND from_id=v_user AND to_id=p_to_user_id AND status='pending' ORDER BY created_at,id LIMIT 1;
  IF v_request IS NOT NULL THEN RETURN v_request; END IF;
  INSERT INTO public.connection_requests(from_id,to_id,room_id) VALUES(v_user,p_to_user_id,p_room_id) RETURNING id INTO v_request;
  RETURN v_request;
END $$;
CREATE OR REPLACE FUNCTION public.invite_room_member(p_room_id uuid,p_to_user_id uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT private.invite_room_member(p_room_id,p_to_user_id) $$;

CREATE OR REPLACE FUNCTION private.accept_connection(p_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_room uuid; v_from uuid; v_to uuid; v_status text;
BEGIN
  SELECT room_id INTO v_room FROM public.connection_requests WHERE id=p_request_id AND to_id=auth.uid();
  IF v_room IS NULL THEN RAISE EXCEPTION 'Invitation is unavailable'; END IF;
  PERFORM 1 FROM public.rooms WHERE id=v_room FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invited room no longer exists'; END IF;
  SELECT from_id,to_id,status INTO v_from,v_to,v_status FROM public.connection_requests WHERE id=p_request_id AND room_id=v_room FOR UPDATE;
  IF NOT FOUND OR v_to IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Invalid invitation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=v_room AND user_id=v_from) THEN RAISE EXCEPTION 'Inviter is no longer a member'; END IF;
  IF v_status='accepted' AND EXISTS(SELECT 1 FROM public.room_members WHERE room_id=v_room AND user_id=v_to) THEN RETURN v_room; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Invitation is not pending'; END IF;
  INSERT INTO public.room_members(room_id,user_id) VALUES(v_room,v_to) ON CONFLICT DO NOTHING;
  UPDATE public.connection_requests SET status='accepted' WHERE id=p_request_id;
  RETURN v_room;
END $$;

CREATE OR REPLACE FUNCTION private.leave_room(p_room_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.rooms WHERE id=p_room_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id AND user_id=auth.uid()) THEN RAISE EXCEPTION 'Not a room member'; END IF;
  UPDATE public.presence SET current_room_id=NULL,is_online=false WHERE user_id=auth.uid() AND current_room_id=p_room_id;
  DELETE FROM public.room_members WHERE room_id=p_room_id AND user_id=auth.uid();
  IF NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id) THEN DELETE FROM public.rooms WHERE id=p_room_id; END IF;
END $$;

REVOKE INSERT, DELETE ON public.room_members FROM authenticated;
REVOKE INSERT(room_id,user_id,joined_at) ON public.room_members FROM authenticated;
REVOKE INSERT ON public.rooms, public.connection_requests FROM authenticated;
REVOKE INSERT(id,invite_code,created_by,created_at,room_name,description) ON public.rooms FROM authenticated;
REVOKE INSERT(id,from_id,to_id,status,created_at,room_id) ON public.connection_requests FROM authenticated;
DROP POLICY IF EXISTS room_members_insert ON public.room_members;
DROP POLICY IF EXISTS room_members_delete ON public.room_members;
DROP POLICY IF EXISTS connection_requests_insert ON public.connection_requests;
DROP POLICY IF EXISTS connection_requests_update ON public.connection_requests;
CREATE POLICY connection_requests_update ON public.connection_requests FOR UPDATE TO authenticated
  USING(to_id=auth.uid() AND status='pending') WITH CHECK(to_id=auth.uid() AND status='declined');

REVOKE UPDATE ON public.profiles FROM authenticated;
REVOKE UPDATE(id,gp_id,display_name,pet_id,skin,created_at) ON public.profiles FROM authenticated;
GRANT UPDATE(display_name,pet_id,skin) ON public.profiles TO authenticated;
CREATE OR REPLACE FUNCTION public.set_profile_gp_id()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.gp_id := public.generate_gp_id(NEW.id);
  NEW.created_at := now();
  RETURN NEW;
END $$;

-- presence 是租约，但不能伪造所在房间。
DROP POLICY IF EXISTS presence_insert ON public.presence;
DROP POLICY IF EXISTS presence_update ON public.presence;
CREATE POLICY presence_insert ON public.presence FOR INSERT TO authenticated WITH CHECK(
  user_id=auth.uid() AND (current_room_id IS NULL OR current_room_id IN(SELECT private.get_my_room_ids())));
CREATE POLICY presence_update ON public.presence FOR UPDATE TO authenticated USING(user_id=auth.uid()) WITH CHECK(
  user_id=auth.uid() AND (current_room_id IS NULL OR current_room_id IN(SELECT private.get_my_room_ids())));

-- 可分享身份与历史消息的常用访问路径。
CREATE INDEX IF NOT EXISTS room_members_user_room_idx ON public.room_members(user_id,room_id);
CREATE INDEX IF NOT EXISTS messages_room_time_idx ON public.messages(room_id,created_at DESC,id DESC) WHERE kind='text';
CREATE INDEX IF NOT EXISTS presence_current_room_idx ON public.presence(current_room_id) WHERE current_room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_pending_recipient_idx ON public.connection_requests(to_id,created_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS requests_sender_idx ON public.connection_requests(from_id,room_id);

REVOKE ALL ON FUNCTION private.create_room(text,uuid),private.invite_room_member(uuid,uuid),private.leave_room(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.create_room(text,uuid),public.invite_room_member(uuid,uuid),public.leave_room(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.create_room(text,uuid),private.invite_room_member(uuid,uuid),private.leave_room(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_room(text,uuid),public.invite_room_member(uuid,uuid),public.leave_room(uuid) TO authenticated;

-- 私有频道只允许房间成员；无效 topic 返回 false，不抛 UUID 转换异常。
CREATE OR REPLACE FUNCTION private.can_access_room_topic(p_topic text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.room_members WHERE user_id=auth.uid()
    AND p_topic IN('presence:'||room_id::text,'interactions:'||room_id::text))
$$;
REVOKE ALL ON FUNCTION private.can_access_room_topic(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.can_access_room_topic(text) TO authenticated;
CREATE POLICY goodpuppy_room_realtime_read ON realtime.messages FOR SELECT TO authenticated
  USING(extension IN('broadcast','presence') AND private.can_access_room_topic(realtime.topic()));
CREATE POLICY goodpuppy_room_presence_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK(extension='presence' AND private.can_access_room_topic(realtime.topic()));

CREATE OR REPLACE FUNCTION private.send_room_interaction(p_room_id uuid,p_action text,p_target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF p_action NOT IN('cuddle','feed','kick') OR p_action IS NULL OR p_target_id=v_user THEN RAISE EXCEPTION 'Invalid interaction'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id AND user_id=v_user)
    OR NOT EXISTS(SELECT 1 FROM public.room_members WHERE room_id=p_room_id AND user_id=p_target_id) THEN RAISE EXCEPTION 'Interaction requires room membership'; END IF;
  PERFORM realtime.send(jsonb_build_object('action',p_action,'actorId',v_user,'targetId',p_target_id),
    'interaction','interactions:'||p_room_id::text,true);
END $$;
CREATE OR REPLACE FUNCTION public.send_room_interaction(p_room_id uuid,p_action text,p_target_id uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT private.send_room_interaction(p_room_id,p_action,p_target_id) $$;
REVOKE ALL ON FUNCTION private.send_room_interaction(uuid,text,uuid),public.send_room_interaction(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION private.send_room_interaction(uuid,text,uuid),public.send_room_interaction(uuid,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.get_pending_room_invitations()
RETURNS TABLE (
  id uuid,
  from_id uuid,
  room_id uuid,
  room_name text,
  profile_id uuid,
  gp_id text,
  display_name text,
  pet_id text,
  skin text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    requests.id,
    requests.from_id,
    requests.room_id,
    rooms.room_name,
    profiles.id AS profile_id,
    profiles.gp_id,
    profiles.display_name,
    profiles.pet_id,
    profiles.skin
  FROM public.connection_requests AS requests
  JOIN public.profiles AS profiles
    ON profiles.id = requests.from_id
  LEFT JOIN public.rooms AS rooms
    ON rooms.id = requests.room_id
  WHERE requests.to_id = auth.uid()
    AND requests.status = 'pending'
    AND requests.room_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.room_members WHERE room_id=requests.room_id AND user_id=requests.from_id)
  ORDER BY requests.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_room_invitations()
RETURNS TABLE (
  id uuid,
  from_id uuid,
  room_id uuid,
  room_name text,
  profile_id uuid,
  gp_id text,
  display_name text,
  pet_id text,
  skin text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT *
  FROM private.get_pending_room_invitations();
$$;

REVOKE ALL ON FUNCTION private.get_pending_room_invitations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pending_room_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_pending_room_invitations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_room_invitations() TO authenticated;

DROP POLICY IF EXISTS rooms_insert ON public.rooms;
NOTIFY pgrst, 'reload schema';
