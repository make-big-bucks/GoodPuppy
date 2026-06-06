# GoodPuppy MVP 整体架构设计

> 状态：草案 / 待评审
> 日期：2026-06-05
> 范围：跨所有 slice 的整体技术架构与数据模型。每个 slice 之后各自展开成独立的 spec → plan → 实现。

## 0. 定位回顾（约束所有技术决策）

GoodPuppy = **一条只通向你最在乎的那几个人的私密、环境式（ambient）在场通道**，住在桌面上。
- 不是"更安静的聊天工具"——重历史浏览、消息搜索等会把它拉回聊天 app，**刻意排除**。
- 核心单位是**房间（亲密小圈子）**，同时覆盖 1:1 和小群，**不是公开大厅**。
- v1 **不需要 AI**。价值来自人与人的连接体验。
- 最高风险待验证假设：**新鲜感过后，亲密关系会不会因"在场感"持续回来用。** 所有功能取舍服务于此。

## 1. 现状诊断（基线）

当前是一个"写死的双人原型"：
- `currentUser` 编译时写死，靠 `build-mac-user-a.js` 给每人单独打包。
- 仅 `user_a`/`user_b`，presence id 写死 1/2，消息分 `user_a_message` / `user_b_message` 双表。
- Supabase anon key 打进二进制，表无 RLS（裸奔）。
- Electron，DMG ~112M（资产仅 650K，体积全部来自 Electron）。
- 渲染固定显示两只 pet。

**差距的本质不是"功能没做完"，而是"还没有用户系统 + 还没有安全边界"。**

## 2. 技术栈决策

| 维度 | 决策 | 理由 |
|---|---|---|
| 客户端框架 | **Tauri**（Rust 主进程 + 系统 webview） | 包体从 ~100M 降到 ~10–20M；趁代码还小迁移成本最低 |
| 前端 | 移植现有 renderer 的 JS/HTML/CSS | 基本可直接复用 |
| 后端 | **托管 Supabase（官方一个）** | v1 只做一个托管后端；自部署留架构缝、产品上 later |
| 实时 | **supabase-js 跑在前端 webview** | Rust 不碰 Supabase；presence/realtime 全在前端 |
| 认证 | **Supabase 匿名登录（anonymous sign-in）** | 零摩擦、无邮箱、原生 JWT；无自建 auth 服务（见 §5） |
| 会话存储 | **supabase-js 默认（refresh token 由 SDK 自管，可选托管至钥匙串）** | 无需自建/自管任何密钥；会话即身份 |

**Tauri 职责划分（关键）：**
- **Rust 主进程（薄）**：单个透明置顶窗口、点击穿透、托盘、窗口层级与必要的系统能力。
- **前端 webview**：所有业务逻辑——Supabase 连接、presence 心跳、消息订阅、auth、pet 渲染、单窗口内布局与动画。

即：现在 `main.js` 里的 presence/订阅逻辑会从主进程**挪到前端 JS**，逻辑更集中。

## 3. 连接配置 seam（为自部署预留）

把 `appConfig` 抽象为**连接 Profile**：

```
ConnectionProfile = { backendUrl, anonKey }
```

- 默认指向官方托管后端，硬编码在构建里。
- 架构上允许将来替换为用户自填的后端（自部署）。
- **v1 不暴露切换 UI**——只留代码缝。

## 4. 数据模型（合并写死的双表）

所有关系均通过统一的 `room` 抽象表达，不区分 1:1 与小圈子——每个房间都有邀请码，都可以分享给他人加入。

用户标识 = **Supabase `auth.uid()`（一个 uuid）**，所有外键都以它为主键。对外可分享的 **GoodPuppy ID** 是基于此 uuid 派生的短码（如 `gp_7h3k9x...`），仅用于"找人/加好友"，不参与鉴权。

> 注：spec 早期版本用"公钥指纹"作主键（密钥对身份）。v1 改为 Supabase 原生身份后，主键回归 uuid；`public_key` 字段移除，留待 v2 密钥对/自部署回归时再加（见 §5）。

```
profiles
  id            uuid pk      -- = auth.uid()（Supabase 匿名/链接后的用户 id）
  gp_id         text unique  -- 对外可分享的 GoodPuppy 短码，由 id 派生
  display_name  text
  pet_id        text         -- 选用的内置 pet
  created_at    timestamptz

rooms
  id            uuid pk
  invite_code   text unique  -- 每个房间都有邀请码，可分享给任意人加入
  created_by    uuid fk → profiles.id
  created_at    timestamptz

room_members
  room_id       uuid fk
  user_id       uuid fk → profiles.id
  joined_at     timestamptz
  primary key (room_id, user_id)

connection_requests          -- 按 GoodPuppy ID 连接：request + approve
  id            uuid pk
  from_id       uuid fk → profiles.id
  to_id         uuid fk → profiles.id
  status        text         -- 'pending' | 'accepted' | 'declined'
  created_at    timestamptz
  -- accepted 时创建一个房间，双方自动加入 room_members

messages
  id            uuid pk
  room_id       uuid fk
  sender_id     uuid fk → profiles.id
  kind          text         -- 'text' | 'emote'
  content       text         -- 文本内容 或 emote 标识
  created_at    timestamptz

presence
  room_id       uuid fk
  user_id       uuid fk → profiles.id
  is_online     bool
  last_seen     timestamptz
  primary key (room_id, user_id)
```

这消灭了 `user_a_message`/`user_b_message` 双表；多人对话是房间的自然结果，无需额外设计。

**两种进入房间的方式（并存）：**
- **按个人 ID**（找人）：B 输入 A 的 GoodPuppy ID → 写 `connection_requests` → A 确认 → 自动建房间，双方加入。
- **按邀请码**（找房间）：把房间的 `invite_code` 分享给任何人，对方输入即可加入。两种方式本质相同——都是加入同一种房间。

## 5. 认证与安全（隐藏的 P0）：Supabase 匿名登录

无邮箱、无魔法链接、**无自建 auth 服务**。v1 身份直接用 **Supabase 匿名登录（anonymous sign-in）**：

```
1. 客户端首次启动 → supabase.auth.signInAnonymously()
2. Supabase 返回一个匿名用户 + 真实 JWT（auth.uid() = uuid）
3. 客户端持有该会话；supabase-js 自动续期 refresh token
4. RLS 直接用 auth.uid() 做隔离，无需自定义 claim
5. 首次登录后写一行 profiles（id = auth.uid()，派生 gp_id）
```

**为什么不用密钥对/挑战-应答（原 spec 方案）：** 那个方案要自建一个 Edge Function 来签 JWT——是相比原生方案唯一多出的、且最容易出安全事故的服务端组件；同时"私钥丢 = 身份丢 + 房间丢"且无找回，反而打脸本产品的留存命题。该模型作为"身份握在自己手里"的长期愿景，与 §3 的自部署 seam 一起**推迟到 v2**（见文末"明确排除/推迟"）。

**RLS 策略（按 `room_id` + 身份隔离）：**
- 用户只能读写自己所属房间（`room_members` 命中当前 `auth.uid()`）的 `messages` / `presence`。
- `messages.sender_id` 必须等于当前 `auth.uid()`（不能冒名发消息）。
- `connection_requests`：只能看到 `from_id` 或 `to_id` 是自己的；只有 `to_id` 能改 status。

**账号找回（v1 取舍，必须向用户讲清）：** 匿名会话本身绑定本机——会话丢（重装/换机）≈ 身份丢。v1 接受这一限制，但留好升级路径：
- **可选链接邮箱/OAuth**：用户真正在乎后，调 `supabase.auth.updateUser({ email })` / `linkIdentity()` 把匿名账号**升级为可找回账号**，`auth.uid()` 不变，房间与连接全部保留。
- v1 默认不强推此步，保持零摩擦；在"换设备/备份"场景的 UI 里引导。

**新增基建：相比邮箱方案 0 个额外服务端组件。** 匿名登录是 Supabase 原生能力，只需在项目设置里开启 anonymous sign-in，并配好 RLS。

## 6. presence 驱动渲染（核心"在场"价值）

- 自己的 pet **常驻**桌面。
- 所有 pet（自己 + 在线远程成员）渲染在**同一个透明置顶窗口**内；presence 变化由前端动态增删 DOM 节点并调整窗口尺寸。
- 成员上线时，在同一窗口内为其 pet 分配槽位并播**到达动画**（"他来了"——情绪的一部分）。
- 离线则其 pet 在同一窗口内退场，动画结束后移除 DOM 节点并收缩窗口。
- 窗口级点击穿透仍只由主窗口承担；前端通过像素级命中测试决定透明区域是否穿透。

## 7. 历史策略（克制，不越界成聊天）

- 在线时实时；**上线时补看最近 N 条**（沿用当前 ~5 条体验）。
- 持久化足够：离线期间别人发的不丢，下次上线可见。
- **不做** scrollback / 搜索 UI。完整历史浏览：明确推迟。

## 8. 情感表达 / 留存层

原则：**情绪穿过 pet（动画发生在对方桌面），不穿过文字。**
- 一排 **emote**：点一下触发对方 pet 一段动画。
- 到达动画、轻量心情/状态、nudge。

## 9. 内置 pet（任意上传推迟）

v1 提供**几个内置 pet 供选择**（沿用 `state_images` 的状态机风格）。任意上传（格式/动画状态机/审核）= v2。

## 10. Slice 路线图

| Slice | 内容 | 优先级 |
|---|---|---|
| 1 | Tauri 行为保真移植（透明置顶窗口+托盘+点击穿透，行为不变） | P0 基建 |
| 2 | Supabase 匿名登录身份 + RLS + 数据模型重构（运行时身份，告别单独打包） | P0 |
| 3 | 连接：按个人 ID（request/approve）+ 邀请码加入房间（第一个"陌生人能连上"版本） | P0 |
| 4 | presence 驱动**单窗口动态多 pet**渲染（自己常驻 + 在线成员 DOM 节点 + 到达动画 + 内置 pet 选） | P0 核心价值 |
| 5 | emote + 轻历史 | P1 留存 |


## 11. 明确排除 / 推迟（v1）

- 自部署后端（留缝，later）
- **密钥对 / SSH 身份模型**（Ed25519 + 挑战-应答 Edge Function + 私钥导出/导入）——"身份握在自己手里"的长期愿景，与自部署一起留作 v2 差异化；v1 用 Supabase 匿名登录替代（见 §5）
- 任意上传 pet（先内置）
- 完整历史浏览 / 搜索
- AI / Agent、养成成长、陌生人发现、公开大厅
