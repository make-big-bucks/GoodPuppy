-- 删除旧的废弃表（保留 user_a_message / user_b_message）
DROP TABLE IF EXISTS public.test CASCADE;
DROP TABLE IF EXISTS public.post CASCADE;
DROP TABLE IF EXISTS public.messages CASCADE;
DROP TABLE IF EXISTS public.presence CASCADE;

-- profiles：用户信息，id = auth.uid()
CREATE TABLE public.profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gp_id         text UNIQUE NOT NULL,
  display_name  text NOT NULL DEFAULT '',
  pet_id        text NOT NULL DEFAULT 'default',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- rooms：每个 1:1 或小圈子对话都是一个房间
CREATE TABLE public.rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code   text UNIQUE NOT NULL,
  created_by    uuid NOT NULL REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- room_members：房间成员多对多
CREATE TABLE public.room_members (
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- connection_requests：按 GoodPuppy ID 互加好友
CREATE TABLE public.connection_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES public.profiles(id),
  to_id      uuid NOT NULL REFERENCES public.profiles(id),
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id),
  CHECK (from_id <> to_id)
);

-- messages：新结构，按房间隔离
CREATE TABLE public.messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES public.profiles(id),
  kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'emote')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- presence：新结构，按房间隔离
CREATE TABLE public.presence (
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_online  bool NOT NULL DEFAULT false,
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
