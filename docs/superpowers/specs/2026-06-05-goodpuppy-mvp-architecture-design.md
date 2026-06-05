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
| 实时/认证 | **supabase-js 跑在前端 webview** | Rust 不碰 Supabase；presence/realtime/auth 全在前端 |

**Tauri 职责划分（关键）：**
- **Rust 主进程（薄）**：透明窗口、置顶、点击穿透、托盘、窗口定位/多窗口生成。
- **前端 webview**：所有业务逻辑——Supabase 连接、presence 心跳、消息订阅、auth、pet 渲染与动画。

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

用单一 `room` 抽象同时覆盖 1:1 与小圈子：

```
profiles
  id            uuid (= auth.users.id)
  display_name  text
  pet_id        text        -- 选用的内置 pet
  created_at    timestamptz

rooms
  id            uuid pk
  invite_code   text unique  -- 邀请码，用于加入
  created_by    uuid
  created_at    timestamptz

room_members
  room_id       uuid fk
  user_id       uuid fk
  joined_at     timestamptz
  primary key (room_id, user_id)

messages
  id            uuid pk
  room_id       uuid fk
  sender_id     uuid fk
  kind          text        -- 'text' | 'emote'
  content       text        -- 文本内容 或 emote 标识
  created_at    timestamptz

presence
  room_id       uuid fk
  user_id       uuid fk
  is_online     bool
  last_seen     timestamptz
  primary key (room_id, user_id)
```

这消灭了 `user_a_message`/`user_b_message` 双表；多人对话是房间的自然结果，无需额外设计。

## 5. 认证与安全（隐藏的 P0）

"开放用户"的前置条件——否则陌生人注册后可读写所有人消息：
- **Supabase Auth**（邮箱/魔法链接，v1 选最简单的一种）。
- **RLS 按 `room_id` 隔离**：用户只能读写自己所属房间（`room_members` 命中）的 `messages` / `presence` / `rooms`。
- anon key 仍在客户端，但 RLS 是真正的安全边界。

## 6. presence 驱动渲染（核心"在场"价值）

- 自己的 pet **常驻**桌面。
- 对房间内**每个在线远程成员** spawn 一只 pet（多窗口或单窗口多 sprite，Slice 4 定）。
- 成员上线时播**到达动画**（"他来了"——情绪的一部分）。
- 离线则其 pet 退场。

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
| 2 | 数据模型重构 + Auth/RLS（运行时选身份，告别单独打包） | P0 |
| 3 | 邀请码配对 + 加入房间（第一个"陌生人能连上"版本） | P0 |
| 4 | presence 驱动渲染（自己常驻 + 在线成员出现 + 到达动画 + 内置 pet 选） | P0 核心价值 |
| 5 | emote + 轻历史 | P1 留存 |

每块独立 spec→plan→实现。

## 11. 明确排除 / 推迟（v1）

- 自部署后端（留缝，later）
- 任意上传 pet（先内置）
- 完整历史浏览 / 搜索
- AI / Agent、养成成长、陌生人发现、公开大厅
