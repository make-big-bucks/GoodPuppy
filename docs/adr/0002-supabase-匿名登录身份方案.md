# ADR-0002：使用 Supabase 匿名登录替代密钥对身份模型

- 状态：已采纳
- 日期：2026-06-05
- 取代：早期 spec 中的 Ed25519 密钥对 + 挑战-应答 Edge Function 方案

## 背景

GoodPuppy 需要一套"零摩擦"的身份方案——用户不应在下载后立刻被要求填邮箱或注册账号，否则与"住在桌面上的亲密在场"定位相悖。

早期 spec 设计了基于 Ed25519 密钥对的身份模型：客户端生成密钥对，公钥作为主键，通过挑战-应答 Edge Function 签发 JWT。这一方案的主要问题：

1. **额外服务端组件**：需要自建一个 Edge Function 签 JWT，是相比原生方案唯一多出的服务端组件，且最容易出安全事故。
2. **身份不可找回**：私钥丢失 = 身份丢失 + 所有房间与连接丢失，无任何找回路径——这直接打脸 GoodPuppy 的留存命题（亲密关系因"在场感"持续回来用）。
3. **增加 v1 复杂度**：密钥导出/导入、私钥备份等 UX 问题需要专门设计，远超 v1 所需。

## 决策

v1 采用 **Supabase 匿名登录（anonymous sign-in）** 作为身份方案。

流程如下：

```
1. 客户端首次启动 → supabase.auth.signInAnonymously()
2. Supabase 返回匿名用户 + 真实 JWT（auth.uid() = uuid）
3. 客户端持有该会话；supabase-js 自动续期 refresh token
4. RLS 直接用 auth.uid() 做隔离，无需自定义 claim
5. 首次登录后写一行 profiles（id = auth.uid()，派生 gp_id）
```

对外可分享的 **GoodPuppy ID**（`gp_id`，如 `gp_7h3k9x...`）由 `auth.uid()` 派生的短码，仅用于"找人/加好友"，不参与鉴权。

账号找回升级路径（v1 不强推，留 UI 入口）：
- 用户在意后，可调 `supabase.auth.updateUser({ email })` / `linkIdentity()` 将匿名账号升级为可找回账号，`auth.uid()` 不变，所有房间与连接全部保留。

密钥对身份模型（"身份握在自己手里"的长期愿景）与自部署一起推迟到 v2。

## 后果

**正面：**
- 零额外服务端组件——匿名登录是 Supabase 原生能力，只需在项目设置里开启。
- 用户首次启动无任何注册流程，零摩擦。
- `auth.uid()` 原生集成 RLS，安全模型简洁。
- 升级路径（链接邮箱/OAuth）清晰，`auth.uid()` 全程不变，留存数据不受影响。

**负面：**
- 匿名会话绑定本机——重装/换机会话丢失 = 身份丢失（v1 接受此限制）。
- 与"身份握在自己手里"的长期愿景存在差距，需要在 v2 用密钥对/自部署方案弥合。
- `public_key` 字段在 v1 数据模型中移除，v2 引入密钥对时需要迁移。

**RLS 策略（须配合实施）：**
- `messages`/`presence`：用户只能读写自己所属房间的数据（`room_members` 中存在当前 `auth.uid()`）。
- `messages.sender_id` 必须等于当前 `auth.uid()`（防止冒名发消息）。
- `connection_requests`：只能看到自己作为 `from_id` 或 `to_id` 的记录；只有 `to_id` 可修改 status。
