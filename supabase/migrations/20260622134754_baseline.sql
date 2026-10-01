-- 2026-10-01 真实数据库业务结构快照，仅用于空库；不得用于覆盖现有环境。

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;

GRANT USAGE ON SCHEMA private TO authenticated;

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  gp_id text NOT NULL,
  display_name text DEFAULT ''::text NOT NULL,
  pet_id text DEFAULT 'default'::text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  skin text DEFAULT 'default'::text NOT NULL
);

CREATE TABLE public.rooms (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invite_code text NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  room_name text,
  description text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.room_members (
  room_id uuid NOT NULL,
  user_id uuid NOT NULL,
  joined_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE public.connection_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  room_id uuid
);

CREATE TABLE public.messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  room_id uuid NOT NULL,
  sender_id uuid,
  kind text DEFAULT 'text'::text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE public.presence (
  current_room_id uuid,
  user_id uuid NOT NULL,
  is_online bool DEFAULT false NOT NULL,
  last_seen timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_check CHECK ((from_id <> to_id));

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_pkey PRIMARY KEY (id);

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])));

ALTER TABLE public.messages ADD CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'emote'::text])));

ALTER TABLE public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE public.presence ADD CONSTRAINT presence_pkey PRIMARY KEY (user_id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_gp_id_key UNIQUE (gp_id);

ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

ALTER TABLE public.room_members ADD CONSTRAINT room_members_pkey PRIMARY KEY (room_id, user_id);

ALTER TABLE public.rooms ADD CONSTRAINT rooms_invite_code_key UNIQUE (invite_code);

ALTER TABLE public.rooms ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_from_id_fkey FOREIGN KEY (from_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL;

ALTER TABLE public.connection_requests ADD CONSTRAINT connection_requests_to_id_fkey FOREIGN KEY (to_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public.messages ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;

ALTER TABLE public.messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE public.presence ADD CONSTRAINT presence_current_room_id_fkey FOREIGN KEY (current_room_id) REFERENCES rooms(id) ON DELETE SET NULL;

ALTER TABLE public.presence ADD CONSTRAINT presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.room_members ADD CONSTRAINT room_members_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;

ALTER TABLE public.room_members ADD CONSTRAINT room_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public.rooms ADD CONSTRAINT rooms_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_anonymous_users(p_grace_days integer DEFAULT 1)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.leave_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.leave_room(p_room_id uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  SELECT private.leave_room(p_room_id)
$function$;

CREATE OR REPLACE FUNCTION private.get_my_room_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT room_id FROM public.room_members WHERE user_id = auth.uid()
$function$;

CREATE OR REPLACE FUNCTION private.join_room_by_invite(p_invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_room_id uuid;
BEGIN
  SELECT id INTO v_room_id FROM public.rooms WHERE invite_code = p_invite_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;

  INSERT INTO public.room_members (room_id, user_id)
  VALUES (v_room_id, auth.uid())
  ON CONFLICT DO NOTHING;

  RETURN v_room_id;
END;
$function$;

CREATE OR REPLACE FUNCTION private.accept_connection(p_request_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.accept_connection(p_request_id uuid)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  SELECT private.accept_connection(p_request_id)
$function$;

CREATE OR REPLACE FUNCTION public.join_room_by_invite(p_invite_code text)
 RETURNS uuid
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  SELECT private.join_room_by_invite(p_invite_code)
$function$;

CREATE OR REPLACE FUNCTION public.generate_gp_id(p_user_id uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 'gp_' || left(replace(p_user_id::text, '-', ''), 8)
$function$;

CREATE OR REPLACE FUNCTION public.set_profile_gp_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.gp_id IS NULL OR NEW.gp_id = '' THEN
    NEW.gp_id := generate_gp_id(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_invite_code()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.set_room_invite_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.invite_code IS NULL OR NEW.invite_code = '' THEN
    NEW.invite_code := generate_invite_code();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.get_pending_room_invitations()
 RETURNS TABLE(id uuid, from_id uuid, room_id uuid, room_name text, profile_id uuid, gp_id text, display_name text, pet_id text, skin text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  ORDER BY requests.created_at ASC;
$function$;

CREATE OR REPLACE FUNCTION public.get_pending_room_invitations()
 RETURNS TABLE(id uuid, from_id uuid, room_id uuid, room_name text, profile_id uuid, gp_id text, display_name text, pet_id text, skin text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT *
  FROM private.get_pending_room_invitations();
$function$;

CREATE TRIGGER profiles_set_gp_id BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_profile_gp_id();

CREATE TRIGGER rooms_set_invite_code BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION set_room_invite_code();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.connection_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY profiles_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK ((id = auth.uid()));

CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));

CREATE POLICY connection_requests_update ON public.connection_requests FOR UPDATE TO authenticated USING ((to_id = auth.uid())) WITH CHECK ((to_id = auth.uid()));

CREATE POLICY rooms_insert ON public.rooms FOR INSERT TO authenticated WITH CHECK ((created_by = auth.uid()));

CREATE POLICY room_members_insert ON public.room_members FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));

CREATE POLICY connection_requests_select ON public.connection_requests FOR SELECT TO authenticated USING (((from_id = auth.uid()) OR (to_id = auth.uid())));

CREATE POLICY connection_requests_insert ON public.connection_requests FOR INSERT TO authenticated WITH CHECK (((from_id = auth.uid()) AND (to_id <> auth.uid())));

CREATE POLICY rooms_select ON public.rooms FOR SELECT TO authenticated USING ((id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids)));

CREATE POLICY room_members_select ON public.room_members FOR SELECT TO authenticated USING ((room_id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids)));

CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated USING ((room_id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids)));

CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (room_id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids))));

CREATE POLICY rooms_update ON public.rooms FOR UPDATE TO authenticated USING ((id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids))) WITH CHECK ((id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids)));

CREATE POLICY presence_select ON public.presence FOR SELECT TO public USING (((user_id = auth.uid()) OR (current_room_id IN ( SELECT private.get_my_room_ids() AS get_my_room_ids))));

CREATE POLICY presence_insert ON public.presence FOR INSERT TO public WITH CHECK ((user_id = auth.uid()));

CREATE POLICY presence_update ON public.presence FOR UPDATE TO public USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

CREATE POLICY room_members_delete ON public.room_members FOR DELETE TO authenticated USING ((user_id = auth.uid()));

REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.rooms FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.room_members FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.connection_requests FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.presence FROM PUBLIC, anon, authenticated;

GRANT INSERT ON public.rooms TO service_role;

GRANT SELECT ON public.rooms TO service_role;

GRANT UPDATE ON public.rooms TO service_role;

GRANT DELETE ON public.rooms TO service_role;

GRANT TRUNCATE ON public.rooms TO service_role;

GRANT REFERENCES ON public.rooms TO service_role;

GRANT TRIGGER ON public.rooms TO service_role;

GRANT INSERT ON public.rooms TO authenticated;

GRANT SELECT ON public.rooms TO authenticated;

GRANT INSERT ON public.profiles TO service_role;

GRANT SELECT ON public.profiles TO service_role;

GRANT UPDATE ON public.profiles TO service_role;

GRANT DELETE ON public.profiles TO service_role;

GRANT TRUNCATE ON public.profiles TO service_role;

GRANT REFERENCES ON public.profiles TO service_role;

GRANT TRIGGER ON public.profiles TO service_role;

GRANT INSERT ON public.profiles TO authenticated;

GRANT SELECT ON public.profiles TO authenticated;

GRANT UPDATE ON public.profiles TO authenticated;

GRANT INSERT ON public.room_members TO service_role;

GRANT SELECT ON public.room_members TO service_role;

GRANT UPDATE ON public.room_members TO service_role;

GRANT DELETE ON public.room_members TO service_role;

GRANT TRUNCATE ON public.room_members TO service_role;

GRANT REFERENCES ON public.room_members TO service_role;

GRANT TRIGGER ON public.room_members TO service_role;

GRANT INSERT ON public.room_members TO authenticated;

GRANT SELECT ON public.room_members TO authenticated;

GRANT INSERT ON public.presence TO service_role;

GRANT SELECT ON public.presence TO service_role;

GRANT UPDATE ON public.presence TO service_role;

GRANT DELETE ON public.presence TO service_role;

GRANT TRUNCATE ON public.presence TO service_role;

GRANT REFERENCES ON public.presence TO service_role;

GRANT TRIGGER ON public.presence TO service_role;

GRANT INSERT ON public.presence TO authenticated;

GRANT SELECT ON public.presence TO authenticated;

GRANT UPDATE ON public.presence TO authenticated;

GRANT INSERT ON public.connection_requests TO service_role;

GRANT SELECT ON public.connection_requests TO service_role;

GRANT UPDATE ON public.connection_requests TO service_role;

GRANT DELETE ON public.connection_requests TO service_role;

GRANT TRUNCATE ON public.connection_requests TO service_role;

GRANT REFERENCES ON public.connection_requests TO service_role;

GRANT TRIGGER ON public.connection_requests TO service_role;

GRANT INSERT ON public.connection_requests TO authenticated;

GRANT SELECT ON public.connection_requests TO authenticated;

GRANT INSERT ON public.messages TO service_role;

GRANT SELECT ON public.messages TO service_role;

GRANT UPDATE ON public.messages TO service_role;

GRANT DELETE ON public.messages TO service_role;

GRANT TRUNCATE ON public.messages TO service_role;

GRANT REFERENCES ON public.messages TO service_role;

GRANT TRIGGER ON public.messages TO service_role;

GRANT INSERT ON public.messages TO authenticated;

GRANT SELECT ON public.messages TO authenticated;

GRANT UPDATE (description) ON public.rooms TO authenticated;

GRANT UPDATE (room_name) ON public.rooms TO authenticated;

GRANT UPDATE (status) ON public.connection_requests TO authenticated;

REVOKE ALL ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_anonymous_users(integer) TO service_role;

REVOKE ALL ON FUNCTION private.leave_room(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.leave_room(uuid) TO PUBLIC;

REVOKE ALL ON FUNCTION public.leave_room(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.leave_room(uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.leave_room(uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.leave_room(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.leave_room(uuid) TO service_role;

REVOKE ALL ON FUNCTION private.get_my_room_ids() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.get_my_room_ids() TO authenticated;

REVOKE ALL ON FUNCTION private.join_room_by_invite(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.join_room_by_invite(text) TO authenticated;

REVOKE ALL ON FUNCTION private.accept_connection(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.accept_connection(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.accept_connection(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.accept_connection(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.accept_connection(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.join_room_by_invite(text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.join_room_by_invite(text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.join_room_by_invite(text) TO service_role;

REVOKE ALL ON FUNCTION public.generate_gp_id(uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.generate_gp_id(uuid) TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_gp_id(uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.generate_gp_id(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.generate_gp_id(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.set_profile_gp_id() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.set_profile_gp_id() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_profile_gp_id() TO anon;

GRANT EXECUTE ON FUNCTION public.set_profile_gp_id() TO authenticated;

GRANT EXECUTE ON FUNCTION public.set_profile_gp_id() TO service_role;

REVOKE ALL ON FUNCTION public.generate_invite_code() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.generate_invite_code() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_invite_code() TO anon;

GRANT EXECUTE ON FUNCTION public.generate_invite_code() TO authenticated;

GRANT EXECUTE ON FUNCTION public.generate_invite_code() TO service_role;

REVOKE ALL ON FUNCTION public.set_room_invite_code() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.set_room_invite_code() TO PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_room_invite_code() TO anon;

GRANT EXECUTE ON FUNCTION public.set_room_invite_code() TO authenticated;

GRANT EXECUTE ON FUNCTION public.set_room_invite_code() TO service_role;

REVOKE ALL ON FUNCTION private.get_pending_room_invitations() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.get_pending_room_invitations() TO authenticated;

REVOKE ALL ON FUNCTION public.get_pending_room_invitations() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_pending_room_invitations() TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_pending_room_invitations() TO service_role;

ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles, public.rooms, public.room_members, public.connection_requests, public.messages, public.presence;

-- 历史原型表只保存结构，不导出数据，默认拒绝客户端访问。
CREATE TABLE public.user_a_message(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),info text,state smallint);
CREATE TABLE public.user_b_message(LIKE public.user_a_message INCLUDING ALL);
ALTER TABLE public.user_a_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_b_message ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_a_message,public.user_b_message FROM anon,authenticated;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_a_message,public.user_b_message;

DO $$ BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN CREATE EXTENSION IF NOT EXISTS pg_cron; END IF;
  PERFORM cron.schedule('cleanup-orphaned-anonymous-users','0 3 * * *','SELECT public.cleanup_orphaned_anonymous_users(1);');
END $$;
