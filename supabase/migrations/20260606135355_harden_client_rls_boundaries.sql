-- Preserve the legacy prototype tables, but remove them from the client access surface.
ALTER TABLE public.user_a_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_b_message ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Enable insert for anon users" ON public.user_a_message;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.user_a_message;
DROP POLICY IF EXISTS "Enable insert for anon users" ON public.user_b_message;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.user_b_message;
REVOKE ALL ON TABLE public.user_a_message FROM anon, authenticated;
REVOKE ALL ON TABLE public.user_b_message FROM anon, authenticated;

-- Public tables are accessed only by signed-in users, with RLS as the row boundary.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON TABLE
  public.profiles,
  public.rooms,
  public.room_members,
  public.connection_requests,
  public.messages,
  public.presence
FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT ON TABLE public.rooms TO authenticated;
GRANT SELECT, INSERT ON TABLE public.room_members TO authenticated;
GRANT SELECT, INSERT ON TABLE public.connection_requests TO authenticated;
GRANT UPDATE (status) ON TABLE public.connection_requests TO authenticated;
GRANT SELECT, INSERT ON TABLE public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.presence TO authenticated;

-- Keep privileged helper logic out of the exposed public API schema.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.get_my_room_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT room_id FROM public.room_members WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION private.accept_connection(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_from_id uuid;
  v_to_id   uuid;
  v_room_id uuid;
BEGIN
  SELECT from_id, to_id INTO v_from_id, v_to_id
  FROM public.connection_requests
  WHERE id = p_request_id
    AND to_id = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or unauthorized connection request';
  END IF;

  UPDATE public.connection_requests
  SET status = 'accepted'
  WHERE id = p_request_id;

  INSERT INTO public.rooms (created_by)
  VALUES (auth.uid())
  RETURNING id INTO v_room_id;

  INSERT INTO public.room_members (room_id, user_id) VALUES
    (v_room_id, v_from_id),
    (v_room_id, v_to_id);

  RETURN v_room_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.join_room_by_invite(p_invite_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

REVOKE ALL ON FUNCTION private.get_my_room_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.accept_connection(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.join_room_by_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_my_room_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION private.accept_connection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.join_room_by_invite(text) TO authenticated;

-- Public RPC entrypoints remain callable, but no longer run as SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.accept_connection(p_request_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.accept_connection(p_request_id)
$$;

CREATE OR REPLACE FUNCTION public.join_room_by_invite(p_invite_code text)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.join_room_by_invite(p_invite_code)
$$;

REVOKE ALL ON FUNCTION public.accept_connection(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_room_by_invite(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_connection(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_room_by_invite(text) TO authenticated;

-- Retire the exposed helper after policies are moved to private.get_my_room_ids().
DROP POLICY IF EXISTS rooms_select ON public.rooms;
DROP POLICY IF EXISTS room_members_select ON public.room_members;
DROP POLICY IF EXISTS messages_select ON public.messages;
DROP POLICY IF EXISTS messages_insert ON public.messages;
DROP POLICY IF EXISTS presence_select ON public.presence;
DROP POLICY IF EXISTS presence_insert ON public.presence;
DROP POLICY IF EXISTS presence_update ON public.presence;
DROP POLICY IF EXISTS connection_requests_update ON public.connection_requests;

CREATE POLICY rooms_select ON public.rooms
  FOR SELECT TO authenticated USING (id IN (SELECT private.get_my_room_ids()));

CREATE POLICY room_members_select ON public.room_members
  FOR SELECT TO authenticated USING (room_id IN (SELECT private.get_my_room_ids()));

CREATE POLICY messages_select ON public.messages
  FOR SELECT TO authenticated USING (room_id IN (SELECT private.get_my_room_ids()));
CREATE POLICY messages_insert ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND room_id IN (SELECT private.get_my_room_ids()));

CREATE POLICY presence_select ON public.presence
  FOR SELECT TO authenticated USING (room_id IN (SELECT private.get_my_room_ids()));
CREATE POLICY presence_insert ON public.presence
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND room_id IN (SELECT private.get_my_room_ids()));
CREATE POLICY presence_update ON public.presence
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND room_id IN (SELECT private.get_my_room_ids()));

CREATE POLICY connection_requests_update ON public.connection_requests
  FOR UPDATE TO authenticated
  USING (to_id = auth.uid())
  WITH CHECK (to_id = auth.uid());

DROP FUNCTION IF EXISTS public.get_my_room_ids();

-- Set fixed search_path on remaining public functions/triggers.
ALTER FUNCTION public.generate_gp_id(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_profile_gp_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_invite_code() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_room_invite_code() SET search_path = public, pg_temp;
