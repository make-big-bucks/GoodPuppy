# ADR-0004：前端 webview 承担所有业务逻辑，Rust 主进程保持薄层

- 状态：已采纳
- 日期：2026-06-05

## 背景

在 Electron 版本中，`main.js`（主进程）同时承担了两类职责：
1. 窗口管理（透明窗口、置顶、托盘）。
2. 业务逻辑（Supabase presence 心跳、实时订阅、消息处理）。

迁移到 Tauri 时，需要决定业务逻辑的归属：Rust 主进程 vs. 前端 webview。

**方案一：Rust 主进程承担业务逻辑**
- Rust 通过 `tauri-plugin-http` / reqwest 调 Supabase REST API。
- Supabase Realtime 需要在 Rust 端维护 WebSocket 连接。
- 需要在 Rust 和前端之间搭建事件桥（Tauri events / commands）传递状态。

**方案二：前端 webview 承担所有业务逻辑**
- `supabase-js` 在前端 webview 中运行，直接连接 Supabase。
- Rust 主进程只做窗口、托盘、点击穿透等 OS 级操作。
- 现有前端 Supabase 代码可直接复用。

## 决策

采用**方案二**：前端 webview 承担所有业务逻辑，Rust 主进程保持薄层。

**Rust 主进程职责（仅限 OS 能力）：**
- 透明窗口创建与配置
- 窗口置顶（always on top）
- 点击穿透（click-through）
- 系统托盘
- 主窗口尺寸、层级和必要的原生光标采样（Slice 4 单窗口 presence 渲染，见 [ADR-0007](0007-单窗口-presence-渲染.md)）

**前端 webview 职责（所有业务逻辑）：**
- Supabase 连接与认证（邮箱密码登录/注册，`auth.uid()` 作为业务身份）
- Presence 心跳与实时订阅（`supabase-js` Realtime channel）
- 消息收发
- Pet 渲染、单窗口内布局与动画
- 根据 presence 状态增删远程 pet DOM 节点，并调用 Tauri window API 调整主窗口尺寸（Slice 4）

## 后果

**正面：**
- `supabase-js` 在 webview 中运行，presence/Realtime 的 JS SDK 可直接使用，无需在 Rust 重实现 WebSocket 客户端。
- 现有 Electron renderer 中的 Supabase 代码可直接迁移至 Tauri webview，改动最小。
- Rust 主进程保持简单，团队只需掌握 Tauri 窗口 API，无需深入 Rust 异步生态。
- 前端调试工具链（浏览器 DevTools）可直接用于业务逻辑调试。

**负面：**
- webview 中的 JS 可以直接访问 Supabase publishable key；该 key 不作为秘密处理，数据隔离依赖 Auth JWT + RLS。
- 单窗口 presence 渲染（Slice 4）需要前端同时协调在线成员集合、DOM 布局、窗口尺寸和点击穿透判定。
- 若未来需要离线能力或后台任务，需要在 Rust 侧补充，届时架构需演进。

**约束：**
- Rust 主进程不持有任何业务状态，不直接调用 Supabase。
- 前端只通过 Tauri API 调用必要的 OS 能力（如调整主窗口尺寸、拖动窗口、设置点击穿透），不把业务状态搬到 Rust 主进程。
