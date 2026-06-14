ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS skin text NOT NULL DEFAULT 'default';

GRANT UPDATE (room_name, description) ON TABLE public.rooms TO authenticated;

DROP POLICY IF EXISTS rooms_update ON public.rooms;

CREATE POLICY rooms_update
ON public.rooms
FOR UPDATE
TO authenticated
USING (id IN (SELECT private.get_my_room_ids()))
WITH CHECK (id IN (SELECT private.get_my_room_ids()));
