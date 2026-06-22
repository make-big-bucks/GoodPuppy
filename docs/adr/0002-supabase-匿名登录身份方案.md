# ADR-0002：使用 Supabase Auth 邮箱密码与匿名快速进入替代密钥对身份模型

- 状态：已采纳（2026-06-18 修订为邮箱密码登录 + 匿名快速进入）
- 日期：2026-06-05
- 取代：早期 spec 中的 Ed25519 密钥对 + 挑战-应答 Edge Function 方案

## 背景

GoodPuppy 需要一套足够简单、可找回、可直接接入 Supabase RLS 的身份方案。用户登录后，所有业务表都以 Supabase `auth.uid()` 作为隔离边界。

早期 spec 设计了基于 Ed25519 密钥对的身份模型：客户端生成密钥对，公钥作为主键，通过挑战-应答 Edge Function 签发 JWT。这一方案的主要问题：

1. **额外服务端组件**：需要自建一个 Edge Function 签 JWT，是相比原生方案唯一多出的服务端组件，且最容易出安全事故。
2. **身份不可找回**：私钥丢失 = 身份丢失 + 所有房间与连接丢失，无任何找回路径——这直接打脸 GoodPuppy 的留存命题（亲密关系因"在场感"持续回来用）。
3. **增加 v1 复杂度**：密钥导出/导入、私钥备份等 UX 问题需要专门设计，远超 v1 所需。

## 决策

v1 采用 **Supabase Auth 邮箱密码登录/注册** 作为可找回身份方案，并提供 **Supabase Auth 匿名登录** 作为低门槛快速进入路径。

流程如下：

```
1. 用户输入邮箱密码登录/注册，或点击「快速进入」创建匿名账号
2. Supabase 返回登录用户 + JWT（auth.uid() = uuid）
3. 客户端持有该会话；supabase-js 自动续期 refresh token
4. RLS 直接用 auth.uid() 做隔离，无需自定义 claim
5. 首次进入 app 后写一行 profiles（id = auth.uid()，派生 gp_id）
6. 匿名账号可通过 `auth.updateUser({ email, password })` 绑定邮箱密码，升级为可找回账号
```

对外可分享的 **GoodPuppy ID**（`gp_id`，如 `gp_7h3k9x...`）由 `auth.uid()` 派生的短码，仅用于"找人/加好友"，不参与鉴权。

密钥对身份模型（"身份握在自己手里"的长期愿景）与自部署一起推迟到 v2。

## 后果

**正面：**
- 零额外服务端组件——邮箱密码登录是 Supabase Auth 原生能力。
- 匿名快速进入降低首次体验门槛，仍然使用 Supabase `auth.uid()` 与现有 RLS。
- 账号可找回，换机/重装后仍能通过邮箱密码恢复同一个 `auth.uid()` 身份。
- `auth.uid()` 原生集成 RLS，安全模型简洁。

**负面：**
- 未绑定的匿名账号退出登录后，本机不再保留该匿名账号会话，用户可能无法找回原账号。
- 与"身份握在自己手里"的长期愿景存在差距，需要在 v2 用密钥对/自部署方案弥合。
- `public_key` 字段在 v1 数据模型中移除，v2 引入密钥对时需要迁移。

**RLS 策略（须配合实施）：**
- `messages`/`presence`：用户只能读写自己所属房间的数据（`room_members` 中存在当前 `auth.uid()`）。
- `messages.sender_id` 必须等于当前 `auth.uid()`（防止冒名发消息）。
- `connection_requests`：只能看到自己作为 `from_id` 或 `to_id` 的记录；只有 `to_id` 可修改 status。
