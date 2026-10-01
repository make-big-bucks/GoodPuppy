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
