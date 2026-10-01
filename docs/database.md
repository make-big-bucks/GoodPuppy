# 数据库与实时协议

> 本批前向迁移尚未应用远端，正在等待明确批准；下文描述新源码与迁移的目标约定，新增 RPC/私有频道需要部署后才能使用。

当前 schema 以 `supabase/migrations/` 为准，本文只说明业务约定，不重复 SQL 实现。历史定义及压缩方法见 `supabase/history/README.md`。

## 业务表

| 表 | 主键及主要字段 | 约定 |
|---|---|---|
| `profiles` | `id`、`gp_id`、`display_name`、`pet_id`、`skin`、`created_at` | `id=auth.uid()`；`gp_id` 由触发器生成且唯一，客户端只能修改自己的昵称、形象和皮肤。 |
| `rooms` | `id`、`invite_code`、`created_by`、`room_name`、`description`、`created_at` | 创建者无特殊房主权限；成员均可改名称/说明。邀请码唯一，创建者被清理后可空。 |
| `room_members` | `(room_id,user_id)`、`joined_at` | 成员关系由授权 RPC 修改，不能通过直接 INSERT/DELETE 绕过加入和退出规则。 |
| `connection_requests` | `id`、`from_id`、`to_id`、`room_id`、`status`、`created_at` | 邀请加入已有房间；状态为 pending/accepted/declined。房间删除后 room_id 可空，该邀请失效。 |
| `messages` | `id`、`room_id`、`sender_id`、`kind`、`content`、`created_at` | 成员可读房间消息，只能以本人身份写入；sender 被清理后置空，保留历史内容。 |
| `presence` | `user_id`、`current_room_id`、`is_online`、`last_seen` | 每用户一行；只能填写本人已加入的房间，current_room_id 可空。 |

用户资料的公开短码用于查找邀请对象，已认证用户可读公开 profiles；其它业务数据按本人或房间成员隔离。所有业务表启用 RLS。未登录的 `anon` 角色没有业务访问权限；匿名领养账号已完成 Auth 登录，使用 `authenticated` 角色，仍受相同成员约束。

历史 `user_a_message`、`user_b_message` 只保留，不参与业务，默认拒绝客户端访问，不能在整理时删除。

## 写入入口

| RPC | 权限与结果 |
|---|---|
| `create_room(p_room_name,p_room_id)` | 建房与加入创建者同一事务；调用者提供 UUID，重试同一 ID 幂等，不能占用他人的 ID。 |
| `join_room_by_invite(p_invite_code)` | 根据合法邀请码加入房间，可重试。 |
| `invite_room_member(p_room_id,p_to_user_id)` | 发起者必须仍是成员，不能邀请自己或已有成员；同一 pending 邀请返回原 ID。 |
| `accept_connection(p_request_id)` | 仅接收者可接受；重新校验邀请者资格，可重试，不能接受已失效或已拒绝邀请。 |
| `get_pending_room_invitations()` | 只返回本人收到的有效 pending 邀请摘要，不泄露无权查看的完整房间。 |
| `leave_room(p_room_id)` | 永久退出；清成员关系和当前在线房间，最后成员退出时删除房间及其级联内容。 |
| `send_room_interaction(p_room_id,p_action,p_target_id)` | 校验双方成员与动作，服务端确定 actorId 后广播，客户端不能冒充发起者。 |

授权实现放在固定空 `search_path` 的 `private` 函数中，`public` 只提供 invoker wrapper；只授权已认证调用者。加入、邀请、接受和永久退出使用同一房间行锁，接受请求再锁请求行，避免重复接受和最后退出/同时加入的竞态。

接收方可直接把自己的 pending 邀请改为 declined；不能通过 UPDATE 改为 accepted 来代替 RPC。客户端不能修改 gp_id、创建时间或他人的资料。昵称/皮肤更新仍受自己的行限制。

## 在线租约与频道

- DB presence 心跳每 60 秒更新 last_seen；超过 3 分钟视为离线。正常退出软件标记离线并记住房间，主动退出房间或注销清除房间。
- `presence:<roomId>` 使用私有频道，track 包含持续状态、pet_id 和 skin；这些客户端表现数据不作为身份或权限依据。
- `interactions:<roomId>` 使用私有频道，接收 `interaction` 事件：`action/actorId/targetId`。动作限 cuddle/feed/kick，广播只能由服务端授权 RPC 发出。
- `realtime.messages` 的读取和 Presence 写入按 topic 校验成员；客户端没有互动 Broadcast INSERT 权限。
- Postgres Changes 用于 messages、presence、connection_requests、room_members、profiles，仍受相应表 RLS。profiles 更新需按已知成员过滤，避免陌生人改名引发刷新。

常用查询索引覆盖用户房间列表、房间文本消息的时间/ID 顺序、当前在线房间以及收发邀请。消息排序应使用 `(created_at,id)`，不能只用时间作为分页游标。

## 删除与匿名账号清理

| 删除对象 | 影响 |
|---|---|
| Auth 用户 | 级联删除 profile、成员关系、presence 和相关邀请；房间创建者与消息发送者置空，保留内容。 |
| 房间 | 级联删除成员及消息，presence 当前房间与邀请 room_id 置空。 |

`cleanup_orphaned_anonymous_users(1)` 仅后台可执行：删除创建超过一天且已无 session 的匿名账号，仍持有 session 的休眠账号不删除。pg_cron 每天 03:00 UTC 执行；不要用最近活动时间替代 session 判定。

## 重建与验证

活动迁移包含无数据基线和后续前向迁移；原 11 个服务器迁移及未登记脚本均保留归档。新 Supabase 环境按活动迁移重建；已有环境对齐压缩后的历史，再执行前向迁移，禁止重放基线或归档中的旧删除语句。

`npm run test:db` 连接独立本机 PostgreSQL（默认 `postgresql://localhost:55432/postgres`，可用 `GOODPUPPY_TEST_DATABASE_URL` 指定），创建随机临时库，验证空库重建、真实角色 RLS/RPC、私有频道策略及多连接并发接受/退出/加入，最后删除该临时库。它拒绝远程连接；Auth/Realtime/cron 平台替身仅用于本地 SQL 测试，不能代替真实服务的连接验收。

## 认证 Presence 租约（准备中）

`20261002073000_authenticated_presence_leases.sql` 已在隔离库验证，**前端尚未切换，不能单独应用远端**。私有 `presence_clients` 保存认证会话、实例版本与退役标记，`presence_leases` 保存成员约束下的实例状态和服务端租约；真实 Auth session/成员删除级联释放，客户端无直接访问权限。

`activate_room_presence`、`update_room_presence`、`deactivate_room_presence` 校验预期账号与真实认证会话，旧版本/已退役激活被拒绝；`get_room_presence`、`get_online_room_presence` 只返回调用者所属房间的有效投影。客户端 track/broadcast 写入权限撤销，实时事件改为读取可信快照的提示，详见 [ADR-0021](adr/0021-认证实例租约与可信在线状态.md)。
