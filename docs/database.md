# GoodPuppy 数据库文档

> 最后更新：2026-06-14
> Supabase 项目：`mrvdeeiiwnegaqjwpsgk`（ap-southeast-2，Postgres 17）
> 适用版本：MVP Slice 2 + Slice 3 数据层

---

## 快速索引

| 类型 | 名称 | 说明 |
|---|---|---|
| 表 | `profiles` | 用户信息，id = auth.uid() |
| 表 | `rooms` | 每个 1:1 或小圈子是一个房间 |
| 表 | `room_members` | 房间成员多对多 |
| 表 | `connection_requests` | 按 GoodPuppy ID 发起的好友请求 |
| 表 | `messages` | 房间内的消息 |
| 表 | `presence` | 各房间内用户的在线状态 |
| 私有函数 | `private.get_my_room_ids()` | 返回当前用户所在的所有 room_id（防 RLS 递归） |
| 函数 | `generate_gp_id(uuid)` | 从 auth.uid() 派生 gp_id 短码 |
| 函数 | `generate_invite_code()` | 生成 8 位随机邀请码 |
| RPC | `public.accept_connection(uuid)` | 原子接受好友请求并建房间的 public wrapper |
| RPC | `public.join_room_by_invite(text)` | 按邀请码加入房间的 public wrapper |
| RPC | `public.leave_room(uuid)` | 永久退出房间；最后一人时自动删除房间 |
| 私有函数 | `private.accept_connection(uuid)` | 接受请求的 `SECURITY DEFINER` 实现 |
| 私有函数 | `private.join_room_by_invite(text)` | 邀请码加入房间的 `SECURITY DEFINER` 实现 |
| 触发器 | `profiles_set_gp_id` | INSERT profiles 时自动生成 gp_id |
| 触发器 | `rooms_set_invite_code` | INSERT rooms 时自动生成 invite_code |
| 保留表 | `user_a_message` | 历史原型遗留，不参与业务，勿删 |
| 保留表 | `user_b_message` | 历史原型遗留，不参与业务，勿删 |

所有业务表均启用 RLS。Realtime 已开启：`messages`、`presence`、`connection_requests`。

安全边界：
- 客户端只允许使用 Supabase `sb_publishable_` key。publishable key 可出现在桌面客户端中，不作为秘密处理。
- 数据访问安全由 Supabase Auth JWT + RLS 策略承担；任何没有登录的 `anon` 角色都没有业务表访问权限。
- `user_a_message` / `user_b_message` 保留为历史原型表，但无 `anon` / `authenticated` 表权限、无 RLS policy，默认拒绝客户端访问。
- 需要绕过 RLS 做原子写入的逻辑放在 `private` schema；`public` schema 只暴露薄 RPC wrapper。

---

## 表结构

### `profiles`

用户身份表。每个登录用户在首次进入 app 时写入一行，`id` 等于 Supabase `auth.uid()`。

```sql
CREATE TABLE public.profiles (
  id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gp_id         text        UNIQUE NOT NULL,  -- 由触发器自动生成，格式 "gp_" + uuid前8位十六进制
  display_name  text        NOT NULL DEFAULT '',
  pet_id        text        NOT NULL DEFAULT 'default',  -- 选用的内置 pet 标识
  skin          text        NOT NULL DEFAULT 'default',  -- 当前 pet 皮肤标识
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**字段说明：**
- `id`：直接等于 `auth.uid()`，不自增，确保一个 auth 账号只有一条 profile。
- `gp_id`：对外可分享的短码（如 `gp_a1b2c3d4`），用于"按人找人"。由触发器在 INSERT 时自动设置，无需前端传入。
- `pet_id`：v1 只支持内置 pet，`default` 为默认值，未来切换内置 pet 时更新此字段。
- `skin`：当前 pet 的皮肤变体，`default` 表示默认皮肤。

---

### `rooms`

房间表。每个 1:1 对话或小圈子都是一个房间，统一结构，无区分。

```sql
CREATE TABLE public.rooms (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code   text        UNIQUE NOT NULL,  -- 由触发器自动生成，8 位随机字符
  created_by    uuid        NOT NULL REFERENCES public.profiles(id),
  room_name     text,
  description   text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**字段说明：**
- `invite_code`：兼容字段，任何人知道这个码就能通过 RPC 加入此房间，由触发器在 INSERT 时自动生成；当前会客厅主流程不再展示邀请码入口。
- `created_by`：建立此房间的用户，通常是发起连接请求一方。通过 `accept_connection()` 创建的房间，`created_by` 是接受方（to_id）。
- `room_name`：用户可见房间名；所有房间成员都可以编辑。
- `description`：用户可见房间简介；所有房间成员都可以编辑。

---

### `room_members`

房间与用户的多对多关系。用户所有的房间通过此表查询。

```sql
CREATE TABLE public.room_members (
  room_id    uuid        NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
```

**说明：**
- 产品主路径是通过 `gp_` 开头的 GoodPuppy ID 发起邀请，对方接受后由 `accept_connection()` RPC 自动建房间并加入双方。`join_room_by_invite()` RPC（输入邀请码）保留为兼容路径，不再是会客厅 UI 的主要入口。
- 前端直接 INSERT 也被 RLS 允许（`user_id = auth.uid()`），但推荐通过 RPC 保证原子性。

---

### `connection_requests`

好友请求表。用户 A 输入 B 的 `gp_id` 后写入一行，B 确认后调用 `accept_connection()`。

```sql
CREATE TABLE public.connection_requests (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid        NOT NULL REFERENCES public.profiles(id),
  to_id      uuid        NOT NULL REFERENCES public.profiles(id),
  status     text        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'declined')),
  room_id    uuid        REFERENCES public.rooms(id) ON DELETE SET NULL,  -- 非空时表示邀请加入指定房间
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id),
  CHECK (from_id <> to_id)
);
```

**字段说明：**
- `status`：只有 `to_id`（收到请求方）能通过 RLS 更新 status，防止发起方自己接受自己的请求。
- `room_id`：可空。非空时表示这是一条"邀请加入指定房间"的请求；接受后 `accept_connection()` 会将双方加入该房间，而不是创建新房间。房间删除时自动置 NULL（`ON DELETE SET NULL`）。
- `UNIQUE (from_id, to_id)`：同一对用户之间只能有一条请求（A→B）。B→A 是另一条独立记录，允许双向同时发起。
- 接受后不删除此记录，保留状态为 `accepted` 作为连接历史。

---

### `messages`

消息表。所有房间的消息统一存储，通过 `room_id` 隔离。

```sql
CREATE TABLE public.messages (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    uuid        NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id  uuid        NOT NULL REFERENCES public.profiles(id),
  kind       text        NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'emote')),
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**字段说明：**
- `kind`：`'text'` 为普通文字消息；`'emote'` 为情感表达（触发对方 pet 动画），v1 暂未启用。
- `content`：`kind = 'text'` 时是消息正文；`kind = 'emote'` 时是 emote 标识符。
- 前端查询时通过 `room_id` 过滤，RLS 保证用户只能读写自己所在房间的消息。

**前端调用示例：**

```js
// 发送消息
await supabase.from('messages').insert({
  room_id: currentRoomId,
  sender_id: selfAuthId,
  kind: 'text',
  content: '你好',
});

// 拉取最近 5 条
const { data } = await supabase
  .from('messages')
  .select('id, content, created_at, sender_id, kind')
  .eq('room_id', currentRoomId)
  .eq('sender_id', targetAuthId)
  .order('created_at', { ascending: false })
  .limit(5);
```

---

### `presence`

在线状态表。每个用户全局只有一行，记录当前所在房间与在线状态。

```sql
CREATE TABLE public.presence (
  user_id          uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_room_id  uuid        REFERENCES public.rooms(id) ON DELETE SET NULL,
  is_online        bool        NOT NULL DEFAULT false,
  last_seen        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);
```

**说明：**
- 每个用户只有一行，从根本上杜绝同时在多个房间显示在线的可能。
- 用户进入房间时 upsert `{ is_online: true, current_room_id: roomId }`，冲突键为 `user_id`。
- 切换房间时直接 upsert 新房间，无需先清除旧房间的记录。
- 退出房间时更新 `{ is_online: false, current_room_id: null }`。
- `current_room_id` 设为 `ON DELETE SET NULL`：房间被删除时自动清空，避免脏数据。
- v1 presence 为被动更新（前端 upsert），v2 可改为服务端心跳检测。

---

## Postgres 函数 & 触发器

### `private.get_my_room_ids()`

```sql
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.get_my_room_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT room_id FROM public.room_members WHERE user_id = auth.uid()
$$;
```

**作用：** 返回当前登录用户所在的所有 `room_id`。

**为什么放在 `private` schema：** 所有需要"判断当前用户在哪些房间"的 RLS 策略（`rooms`、`room_members`、`messages`、`presence`）都依赖此函数。如果在 RLS 策略里直接查 `room_members`，会触发对 `room_members` 自身 RLS 的递归调用。`SECURITY DEFINER` 打破递归；`private` schema 避免把 helper 暴露成 public RPC。

---

### `generate_gp_id(p_user_id uuid)`

```sql
CREATE OR REPLACE FUNCTION generate_gp_id(p_user_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'gp_' || left(replace(p_user_id::text, '-', ''), 8)
$$;
```

**作用：** 从 uuid 派生可分享的 GoodPuppy 短码。

**规则：** 去掉 uuid 中的连字符后取前 8 位十六进制字符，加前缀 `gp_`。
例：`auth.uid() = "a1b2c3d4-xxxx-..."` → `gp_id = "gp_a1b2c3d4"`。

**碰撞概率：** 1 / 16^8 ≈ 四十亿分之一，MVP 阶段可接受；`UNIQUE` 约束会在极罕见的碰撞时报错。

---

### `generate_invite_code()`

```sql
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
```

**作用：** 生成 8 位小写字母+数字的随机邀请码（约 2.8 万亿种组合）。碰撞时 `UNIQUE` 约束报错，前端应提示重试。

---

### 触发器：`profiles_set_gp_id`

```sql
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
```

**作用：** INSERT profiles 时，若未指定 `gp_id`，自动填充。前端只需传 `id` 和 `display_name`，无需计算 `gp_id`。

---

### 触发器：`rooms_set_invite_code`

```sql
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
```

**作用：** INSERT rooms 时，若未指定 `invite_code`，自动生成。通过 `accept_connection()` 建房间时也依赖此触发器。

---

### `accept_connection(p_request_id uuid)` → `uuid`

```sql
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
  -- 验证：请求存在、当前用户是接收方、状态为 pending
  SELECT from_id, to_id INTO v_from_id, v_to_id
  FROM public.connection_requests
  WHERE id = p_request_id
    AND to_id = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or unauthorized connection request';
  END IF;

  -- 原子执行：改状态 → 建房间 → 加双方成员
  UPDATE public.connection_requests SET status = 'accepted' WHERE id = p_request_id;

  INSERT INTO public.rooms (created_by)
  VALUES (auth.uid())
  RETURNING id INTO v_room_id;

  INSERT INTO public.room_members (room_id, user_id) VALUES
    (v_room_id, v_from_id),
    (v_room_id, v_to_id);

  RETURN v_room_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_connection(p_request_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.accept_connection(p_request_id)
$$;
```

**作用：** 接受连接请求。若请求携带 `room_id`（邀请加入已有房间），则将双方加入该房间（幂等）；若无 `room_id`，则创建新 1:1 房间并将双方加入。所有操作在同一事务内原子执行。

**为什么拆成 private 实现 + public wrapper：** 需要同时写 `connection_requests`、`rooms`、`room_members`，所以 private 实现使用 `SECURITY DEFINER` 绕过 RLS 做原子写入。public wrapper 是 `SECURITY INVOKER`，只负责给客户端提供 RPC 入口，并且只授予 `authenticated` 执行权限。

**前端调用：**

```js
const { data: roomId, error } = await supabase.rpc('accept_connection', {
  p_request_id: requestId,
});
```

---

### `join_room_by_invite(p_invite_code text)` → `uuid`

```sql
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
  ON CONFLICT DO NOTHING;  -- 已在房间中则静默忽略

  RETURN v_room_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_room_by_invite(p_invite_code text)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT private.join_room_by_invite(p_invite_code)
$$;
```

**作用：** 按邀请码加入房间。重复加入时幂等（`ON CONFLICT DO NOTHING`）。

**前端调用：**

```js
const { data: roomId, error } = await supabase.rpc('join_room_by_invite', {
  p_invite_code: 'x7k2m9pq',
});
```

---

## RLS 策略

所有表均启用 RLS（`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`）。核心原则：**用户只能访问自己所在房间的数据**，通过 `private.get_my_room_ids()` 函数实现无递归的成员关系查询。

### `profiles`

| 操作 | 策略 |
|---|---|
| SELECT | `true`（所有登录用户可读，用于按 gp_id 搜索好友） |
| INSERT | `id = auth.uid()` |
| UPDATE | `id = auth.uid()`；客户端主要更新 `display_name`、`pet_id`、`skin` |

```sql
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
```

### `rooms`

| 操作 | 策略 |
|---|---|
| SELECT | 当前用户是该房间成员 |
| INSERT | `created_by = auth.uid()` |
| UPDATE | 当前用户是该房间成员；客户端只授予 `room_name`、`description` 列更新权限 |

```sql
CREATE POLICY "rooms_select" ON public.rooms
  FOR SELECT TO authenticated USING (id IN (SELECT private.get_my_room_ids()));
CREATE POLICY "rooms_insert" ON public.rooms
  FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY "rooms_update" ON public.rooms
  FOR UPDATE TO authenticated
  USING (id IN (SELECT private.get_my_room_ids()))
  WITH CHECK (id IN (SELECT private.get_my_room_ids()));
```

### `room_members`

| 操作 | 策略 |
|---|---|
| SELECT | 当前用户是该房间成员（可见同房间其他成员） |
| INSERT | `user_id = auth.uid()`（只能将自己加入房间） |
| DELETE | `user_id = auth.uid()`（只能移除自己） |

```sql
CREATE POLICY "room_members_select" ON public.room_members
  FOR SELECT TO authenticated USING (room_id IN (SELECT private.get_my_room_ids()));
CREATE POLICY "room_members_insert" ON public.room_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "room_members_delete" ON public.room_members
  FOR DELETE TO authenticated USING (user_id = auth.uid());
```

### `connection_requests`

| 操作 | 策略 |
|---|---|
| SELECT | `from_id = auth.uid() OR to_id = auth.uid()` |
| INSERT | `from_id = auth.uid() AND to_id <> auth.uid()` |
| UPDATE | `to_id = auth.uid()` 且只授予 `status` 列更新权限 |

```sql
CREATE POLICY "connection_requests_select" ON public.connection_requests
  FOR SELECT TO authenticated USING (from_id = auth.uid() OR to_id = auth.uid());
CREATE POLICY "connection_requests_insert" ON public.connection_requests
  FOR INSERT TO authenticated WITH CHECK (from_id = auth.uid() AND to_id <> auth.uid());
CREATE POLICY "connection_requests_update" ON public.connection_requests
  FOR UPDATE TO authenticated
  USING (to_id = auth.uid()) WITH CHECK (to_id = auth.uid());
```

### `messages`

| 操作 | 策略 |
|---|---|
| SELECT | `room_id IN private.get_my_room_ids()` |
| INSERT | `sender_id = auth.uid()` 且 `room_id IN private.get_my_room_ids()` |

```sql
CREATE POLICY "messages_select" ON public.messages
  FOR SELECT TO authenticated USING (room_id IN (SELECT private.get_my_room_ids()));
CREATE POLICY "messages_insert" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = auth.uid() AND room_id IN (SELECT private.get_my_room_ids()));
```

### `presence`

| 操作 | 策略 |
|---|---|
| SELECT | `user_id = auth.uid()` 或 `current_room_id IN private.get_my_room_ids()` |
| INSERT | `user_id = auth.uid()` |
| UPDATE | `user_id = auth.uid()` |

```sql
CREATE POLICY "presence_select" ON public.presence
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR current_room_id IN (SELECT private.get_my_room_ids())
  );
CREATE POLICY "presence_insert" ON public.presence
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "presence_update" ON public.presence
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
```

---

## Realtime 订阅

以下表已加入 `supabase_realtime` publication，支持前端 `postgres_changes` 实时订阅：

| 表 | 用途 |
|---|---|
| `messages` | 实时收取新消息 |
| `presence` | 实时感知对方上下线 |
| `connection_requests` | 实时收到好友请求通知 |
| `room_members` | 实时感知房间成员加入/退出 |

**前端订阅示例（messages）：**

```js
supabase
  .channel('room-messages-' + roomId)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'messages',
    filter: `room_id=eq.${roomId}`,  // 必须加 room_id 过滤，否则会收到所有房间的消息
  }, (payload) => {
    handleNewMessage(payload.new);
  })
  .subscribe();
```

> **注意：** Realtime 订阅会受 RLS 过滤，用户只会收到自己有权限读取的行的变更事件。即便不加 `filter`，用户也看不到其他房间的消息——但加上 `filter` 可以减少网络传输量。

---

## 桌宠动画实时协议（无表，纯 Realtime）

桌宠的动画交互不落库，全部走 Supabase Realtime 的客户端能力，不新增任何表。详见 [ADR-0008](adr/0008-分层动画状态机与实时事件.md)。

### 持续状态 + 形象（presence payload）

房间 presence channel（`presence:${roomId}`）的 track payload 在原有字段外携带持续状态与所选形象，让远端桌宠渲染正确形象并反映对方的情绪/工作状态：

```jsonc
{
  "user_id": "<uuid>",
  "online_at": "<ISO 时间>",
  "status": "happy" | "sad" | "busy" | "bored" | null, // 持续状态，单槽互斥，null 表示正常
  "pet_id": "default"                                    // 所选形象，未知回退默认
}
```

本地状态变化时通过 `presenceChannel.track(...)` 重新广播（见 `src/windows/pet/presence.ts` 的 `updateLocalPresence`）。`status` 的取值与 `src/windows/pet/animationCatalog.ts` 的状态层定义一致。

### 一次性互动（broadcast channel）

跨用户的瞬时互动（贴贴/喂食/踢飞、进出场打招呼等高频低价值信号）走 room 维度单独一条 broadcast channel（`interactions:${roomId}`，见 `src/windows/pet/interactions.ts`），纯瞬时、不落库、不进消息历史：

```jsonc
// event: "interaction"
{
  "action": "cuddle" | "feed" | "kick", // 见 animationCatalog.INTERACTIONS
  "actorId": "<发起者 uuid>",
  "targetId": "<被作用者 uuid>"
}
```

「由谁播」遵循单角色原则：`kick`/`feed` 由**目标** pet 播，`cuddle` 由**发起者** pet 播。broadcast 配置 `self: false`，发起方本地直接播放、不回环。

> **为什么不复用 `messages.kind='emote'` 落库？** 互动信号高频、瞬时、对持久化价值很低；落库会污染文字消息历史并产生无谓写入。`messages` 的 `emote` 取值在 v1 仍保留未启用。

---

## 关键设计决策 & 已知约束

**1. 为什么用 `private.get_my_room_ids()` 而不是直接查 `room_members`？**
在 `room_members` 的 RLS 策略里查询 `room_members` 自身会触发递归：策略 → 查表 → 触发策略 → 死循环。`private` schema 中的 `SECURITY DEFINER` 函数绕过 RLS 直接访问底层数据，一次性返回所有 room_id，其他表的 RLS 策略引用此函数即可。

**2. `gp_id` 是确定性的还是随机的？**
确定性（从 uuid 派生）。好处：同一个用户的 gp_id 永远不变，重建 profile 不会漂移。坏处：如果两个 uuid 前 8 位相同会碰撞（约四十亿分之一概率），`UNIQUE` 约束会报错，极罕见场景下需要手动处理。

**3. `connection_requests` 的多次连接**
`UNIQUE (from_id, to_id)` 约束已移除。同一对用户可以在永久退出旧房间后再次发起连接请求、建立新房间。UI 层应在发起请求前检查对方是否已经向自己发过 pending 请求，直接接受而不是再发一条新的。

**4. `accept_connection()` 的 `created_by` 是谁？**
接受方（`to_id`，即 `auth.uid()`）。这是实现细节，业务上无区别——两者都加入了房间，房间创建者在产品层面没有特殊权限。

**5. 多房间支持**
当前前端（`renderer.ts`）只加载用户的第一个房间（`.limit(1)`）。数据库层已支持多房间，切换多房间的 UI 是未来迭代项。

**6. `invite_code` 的安全性**
邀请码是"知道即可加入"的设计，适合亲密小圈子分享。不适合公开发布。v1 没有邀请码撤销机制，这是已知限制。
