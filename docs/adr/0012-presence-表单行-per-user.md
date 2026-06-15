# ADR-0012：Presence 表重构为每用户单行

- 状态：已采纳
- 日期：2026-06-15

## 背景

原 `presence` 表以 `(room_id, user_id)` 为联合主键，即每个用户在每个房间各有一行独立记录。这个设计在以下场景会产生 Bug：

1. **跨房间脏数据**：用户切换房间时，前端需要显式更新旧房间的 `is_online = false`，再 upsert 新房间的 `is_online = true`。两次写操作均为 fire-and-forget（`void`），存在竞态窗口——若旧房间的清除请求因网络延迟滞后于新房间的 upsert，lounge 面板会同时显示用户在两个房间在线。
2. **崩溃遗留**：App 强退时 `exitCurrentRoom` 不会执行，旧房间的 `is_online = true` 会一直保留，直到下次正常退出才清除。

## 决策

将 `presence` 表重构为**每用户全局只有一行**，以 `user_id` 为主键，`room_id` 改名为 `current_room_id` 并设为可空：

```sql
CREATE TABLE public.presence (
  user_id          uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  current_room_id  uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  is_online        bool NOT NULL DEFAULT false,
  last_seen        timestamptz NOT NULL DEFAULT now()
);
```

前端操作简化为：

- **进入/切换房间**：`upsert({ user_id, current_room_id: roomId, is_online: true }, { onConflict: "user_id" })`
- **退出房间**：`update({ is_online: false, current_room_id: null }) .eq("user_id", selfAuthId)`

切换房间时不再需要先清除旧房间，单行 upsert 天然保证原子性。

Lounge 面板判断成员是否在线的条件从 `presence.is_online` 改为 `presence.is_online && presence.current_room_id === roomId`，确保用户只在当前所在房间显示在线状态。

## 后果

**正面：**
- 从数据模型层面彻底消除多房间同时在线的可能，无需依赖客户端的清除顺序。
- 减少前端代码：`switchRoom` 不再需要 `prevRoomId` 追踪和旧房间清除逻辑。
- `current_room_id ON DELETE SET NULL` 覆盖房间删除场景，不产生孤立脏数据。

**负面：**
- 无法再独立查询"某房间内曾经在线的历史成员"——但 v1 不需要此功能。
- Lounge 的 presence 查询由 `in("room_id", roomIds)` 改为 `in("current_room_id", roomIds)`，语义略有变化：只能查到当前在线用户，不能查到所有房间成员的历史状态。离线成员的状态由 `buildMemberViewModels` 默认为 `isOnline: false` 处理，行为不变。

**不变：**
- Supabase Realtime presence channel（`presence:${roomId}`）逻辑不变，仍用于同一房间内宠物的实时状态广播（动画、情绪、换肤），与 DB `presence` 表各自独立。
