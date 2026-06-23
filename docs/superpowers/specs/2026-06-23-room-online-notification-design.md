# 设计文档：房间上线提醒（自绘 Toast 提示窗）

- 日期：2026-06-23
- 状态：待评审
- 相关 ADR：`docs/adr/0001-tauri-替代-electron.md`、`docs/adr/0004-前端-webview-承担业务逻辑.md`、`docs/adr/0008-分层动画状态机与实时事件.md`
- 相关代码：`src/windows/pet/presence.ts`、`src/windows/lounge/lounge.ts`、`src-tauri/src/platform.rs`、`src-tauri/src/commands.rs`、`src/shared/bridge.ts`

## 1. 背景与目标

用户希望：**当自己所属的某个房间里有人上线时，弹出一条系统级提示**，让用户看到「是谁来了」（名字 + 形象）以及「在哪个房间」，并能一键进入该房间。

### 调研结论（为什么不用 OS 原生通知）

- Tauri v2 官方 `tauri-plugin-notification` 桌面端底层是 `notify-rust`，其**动作按钮（`action()` + `wait_for_action`）只在 Linux/XDG 可用**；macOS 走 `mac-notification-sys`（NSNotification 的受限子集），Windows 走 `winrt-notification`（只能显示、不回传点击）。`registerActionTypes`/`onAction` 仅面向移动端。
- 因此「头像 + 按钮 + 点击进入指定房间」**无法用现成插件在 Mac/Win 上稳定实现**。系统本身支持（Win toast `<action>`、macOS `UNNotificationAction`），但要回传点击需自行注册 AUMID + COM 激活器（Win）/ notification category（macOS），属于两套原生实现，与 ADR-0004「Rust 主进程保持薄层」相悖。
- 本项目本就大量生成透明置顶子窗口（pet 窗、bubble 窗）。复用同一机制自绘 Toast 窗，外观与按钮**完全自控、两系统一致**，是更优解。

### 目标

1. 在 Lounge 中按房间提供「上线提醒」开关，开启后**持久生效**（即使 Lounge 收进托盘也在后台监听）。
2. 有人「上线」（= 进入该房间、pet 出现）时，在屏幕系统通知位置弹出一张**不透明圆角卡片**：宠物静态形象 + 名字 + 房间名 + 「进入房间」按钮 + 关闭按钮。
3. 点击「进入房间」走现有进房间流程。
4. Mac 与 Windows 行为一致；多显示器正确定位；**全屏时不打断，退出全屏后补弹**。

## 2. 范围

### In scope（v1）

- Lounge 内按房间的持久订阅开关（状态存 localStorage）。
- 常驻 Lounge 窗口承载多房间 presence 订阅与去重。
- 自绘 Toast 窗口：spawn、UI、定位、自动消失、手动关闭、点击进入。
- 新增 native 命令：按指定显示器取 work area；查询「当前是否适合弹出」（全屏/演示检测）。
- 全屏排队：检测到不可见/全屏时挂起，恢复可见后补弹。

### Out of scope（v1 不做，见 §11）

- 真·浮在他人全屏之上（v2，需重测 Mac Space/销毁逻辑）。
- 真人头像（avatar_url + Storage），v1 一律用宠物形象。
- 「对方仅登录、未进任何房间」的检测。
- 提醒历史/通知中心、声音自定义、免打扰时段。

## 3. 名词与语义

- **上线**：某用户**进入房间**（其 pet 在该房间 track presence）。沿用现有 presence 语义（`src/windows/pet/presence.ts` 仅在进房间时 `track`）。「仅登录未进房」不算上线、不提醒。
- **订阅**：用户在 Lounge 对某房间打开「上线提醒」开关。开关是**持久**状态：开启后即便 Lounge 隐藏（托盘），后台仍监听；关闭或退出 App 才停止。
- **提示窗 / Toast**：一次性 spawn 的独立置顶窗口，承载一张卡片，可自动消失或手动关闭。

## 4. 架构总览

```
┌────────────────────────── 常驻 Lounge 窗口（webview，永不销毁） ──────────────────────────┐
│  既有：supabase 会话、房间/成员/profile 数据、presence 一次性 fetch                        │
│                                                                                          │
│  新增 onlineNotifier 模块：                                                               │
│   - 订阅管理器：读 localStorage 的订阅开关 → 为每个 ON 的房间建 presence:${roomId} 频道    │
│   - 上线检测：监听各频道 join 事件，过滤自己 + 初次 sync 回填 → 产出「上线事件」           │
│   - 弹窗调度：查询「是否可弹」(native) → 可则 spawn toast；不可则入队，恢复后补弹          │
│   - 进房间路由：toast 按钮回传 → Lounge 复用现有 emit("switch-room", {roomId})            │
└──────────────────────────────────────────────────────────────────────────────────────┘
                      │ spawn_toast_window (native, 仿 spawn_pet_window)
                      ▼
        ┌──────────── Toast 窗口（windows/toast.html，透明置顶，可销毁）─────────────┐
        │  圆角不透明卡片：宠物形象 + 名字 + 房间名 + [进入房间] [×]                  │
        │  事件：点击进入 → emit 给 Lounge；关闭/超时 → 通知 Lounge 关闭并回收窗口    │
        └──────────────────────────────────────────────────────────────────────────┘

native（src-tauri，薄层系统能力）：
  - get_monitor_work_area(monitor_index?) → 扣除菜单栏/dock/taskbar 的可用区
  - can_show_notification() → 全屏/演示检测（Mac: 目标屏是否在全屏 Space；Win: SHQueryUserNotificationState）
  - spawn_toast_window / close_toast_window → 仿 spawn_pet_window
```

**为什么宿主放 Lounge**：`main`（pet）与 `lounge` 都是启动即创建、关闭/登出仅 `hide()` 永不销毁的窗口（见 `src-tauri/src/lib.rs:131`、`:156`）。只要 App 运行，**Lounge 的 JS 一直在跑**，且它已持有 supabase 会话与全部房间/profile 数据。pet 在「未登录/未进房」时是 hidden，不能承载后台订阅与弹窗。故订阅与调度放 Lounge，Toast 用独立窗口，**不依赖 pet 是否可见**。

## 5. 组件详述

### 5.1 订阅管理器（`src/windows/lounge/onlineNotifier.ts`，新增）

- 职责：维护「房间 → presence 频道」映射，按订阅开关增删频道。
- 输入：当前用户房间列表（Lounge 已有 `rooms`）、订阅开关集合（localStorage）。
- 接口：
  - `initOnlineNotifier(supabase, getRooms, getSelfId)`：启动，按已存开关建频道。
  - `setRoomSubscribed(roomId, on)`：开/关单房间，落 localStorage 并增删频道。
  - `isRoomSubscribed(roomId): boolean`：供 UI 渲染开关态。
  - `disposeOnlineNotifier()`：登出/退出时清理全部频道。
- 频道复用现有命名 `presence:${roomId}`，**只 `on('presence', {event:'join'})` 监听、不 `track`**（避免把 Lounge 误算成「在房间里」）。
- 房间列表变化（加入/退出房间）时同步：对已不属于自己的房间移除频道与开关。

### 5.2 上线检测与去重

- 监听每个订阅频道的 `join` 事件，拿到新加入的 presence key 与 meta（含 `pet_id`/`skin`/`user_id`）。
- **过滤规则**：
  1. 跳过自己（key === selfId）。
  2. **跳过初次订阅的回填**：频道 `subscribe` 后首个 `sync` 之前已在线的人不算「刚上线」。实现：频道首个 `sync` 完成时记 `readyAt`，之后的 `join` 才算上线事件。
  3. 去抖：同一 `(roomId, userId)` 在 N 秒（默认 10s）内重复 join（断线重连等）只提示一次。
- 输出「上线事件」`{ roomId, roomName, userId, displayName, petId, skin }`。`displayName` 由 Lounge 已有的 `profiles` 缓存解析（改名自动跟随，缺失时回退 gp_id 末位标签，复用 `loungeViewModels.getDisplayName`）。

### 5.3 弹窗调度与 Toast 窗口

**调度**：

1. 收到上线事件 → 决定目标显示器（§7 多屏）。
2. 调 native `can_show_notification(monitorIndex)`：
   - 返回「可弹」→ 取该屏 work area，计算卡片位置，`spawn_toast_window`。
   - 返回「不可弹」（全屏/演示）→ 事件入**待弹队列**；监听恢复信号（§7 全屏），恢复后逐条补弹。
3. 多条并存时纵向堆叠（Mac 自上而下、Win 自下而上），最多同时显示 K 条（默认 3），超出排队。

**Toast 窗口**（`windows/toast.html` + `src/windows/toast/toast-main.ts`，新增）：

- 透明窗口 + 内部不透明圆角卡片（沿用 bubble 窗的「透明窗画不透明内容」做法，保证圆角干净）。置顶、`skipTaskbar`、不抢焦点（不激活 App）。
- macOS 套用 `configure_floating_overlay`（popup 级、不加入 all Spaces——与 pet 一致，故全屏时本就不显示，配合 §7 排队）。
- 内容：宠物静态形象（`public/pets/<petId>/skins/<skin>/` 解析，复用 `animationCatalog` 的皮肤路径逻辑取一帧静态图）、名字、房间名、主按钮「进入房间」、关闭「×」。
- 生命周期：
  - 自动消失：默认 8s。**计时仅在窗口实际可见后开始**（§7：被全屏遮挡时不计时）。
  - 手动关闭：点「×」立即关闭。
  - 点「进入房间」：回传 Lounge → `emit("switch-room", {roomId})`（现有流程，`lounge-main.ts:142`），随后关闭 toast 并显示 Lounge/pet。
  - 关闭即 `close_toast_window` 回收，触发堆叠重排与队列出队。

### 5.4 Native 命令（`src-tauri/src/commands.rs` + `platform.rs`，薄层）

- `get_monitor_work_area(monitor_index: Option<usize>) -> Rect`：
  - macOS：对应 `NSScreen` 的 `visibleFrame`（已依赖 `objc2-app-kit`），换算逻辑像素。修正现有 `getMonitorWorkArea` 实为整屏的问题（`src/shared/bridge.ts:46` 用了 `monitor.size` 未扣 dock/菜单栏）。
  - Windows：`MonitorFromPoint`/枚举 + `GetMonitorInfo` 的 `rcWork`（已依赖 `windows-sys`，需启用 `Win32_Graphics_Gdi` / `Win32_UI_WindowsAndMessaging` 等 feature）。
- `can_show_notification(monitor_index: Option<usize>) -> bool`：
  - macOS：判断目标屏当前是否处于他人全屏 Space（不可弹）。实现取 `NSScreen` 与活动 Space 状态；简化可用「目标屏 work area 高度 ≈ 全屏高度（菜单栏/dock 被隐藏）」启发式，或观测 toast 自身 `isOnActiveSpace`。
  - Windows：`SHQueryUserNotificationState`，遇 `QUNS_BUSY`/`QUNS_RUNNING_D3D_FULL_SCREEN`/`QUNS_PRESENTATION_MODE`/`QUNS_NOT_PRESENT` 视为不可弹。
- `spawn_toast_window` / `close_toast_window`：仿 `spawn_pet_window`（`commands.rs:59`）。窗口 label 形如 `toast-<seq>`。

> 平台差异遵循 CLAUDE.md：Rust 侧用 `#[cfg(target_os = ...)]` 隔离；不引入仅 Mac 行为到前端。

### 5.5 进入房间动作流

Toast「进入房间」→ Toast 窗 `emit` 给 Lounge（带 roomId）→ Lounge 调既有 `onEnterRoom(roomId)` / `emit("switch-room", {roomId})`（`lounge-main.ts:141`）→ pet 协调者进房、显示 pet，Lounge 按现有逻辑隐藏。**不新增进房路径，纯复用。**

## 6. 数据流（时序）

```
用户B 进入房间R（其 pet track presence:R）
        │ Supabase Realtime
        ▼
用户A 的 Lounge：presence:R 频道 join 事件（readyAt 之后、非自己、未去抖）
        ▼
产出上线事件 {R, B, petId, skin}
        ▼
can_show_notification(targetMonitor)?
   ├─ 是 → get_monitor_work_area → 计算位置 → spawn_toast_window → 卡片可见 → 起 8s 计时
   └─ 否 → 入待弹队列 → 监听恢复 → 退出全屏/演示后逐条补弹
        ▼
用户A 点「进入房间」 → emit switch-room → 进房间（现有流程） → 关闭 toast
```

## 7. 边界情况

- **多显示器**：目标屏取「光标当前所在屏」（复用 `src-tauri/src/cursor.rs` 的原生光标采样；无则退化主屏）。`availableMonitors()` 定位，`get_monitor_work_area(index)` 取该屏可用区。
- **全屏（Mac 为主）**：v1 **方案 1——不覆盖全屏**。toast 与 pet 同为不加入 all Spaces 的普通窗口，全屏 Space 下本就不显示；调度侧用 `can_show_notification` 判定并排队，恢复信号：
  - macOS：监听活动 Space 变化（`NSWorkspaceActiveSpaceDidChangeNotification`，或轮询 `isOnActiveSpace`）。
  - Windows：恢复信号轮询 `SHQueryUserNotificationState` 回到 `QUNS_ACCEPTS_NOTIFICATIONS`。
  - 自动消失计时仅在可见后开始，避免「全屏期间静默过期」。
- **Windows 独占全屏游戏**：`SHQueryUserNotificationState` 报全屏 → 排队，退出后补弹；不强弹、不闪烁。
- **多条 toast**：纵向堆叠，最多 K 条同时显示，超出排队；某条关闭后重排并出队。
- **自己**：始终过滤，自己进房不提醒。
- **离线/断线重连**：去抖窗口内重复 join 不重复提示。
- **改名 / 换肤**：名字用实时 profile 解析；形象用事件携带的 `pet_id`/`skin`，与房间内 pet 一致。
- **房间退出 / 被移除**：同步移除该房间频道与订阅开关。
- **未登录**：无 supabase 会话时不订阅；登录后（`auth-ready`）初始化。

## 8. 持久化

- 订阅开关存 localStorage，键 `goodpuppy.onlineNotify.subscribedRooms`，值为 `roomId[]`（JSON）。
- 按账号隔离：键追加 selfId 后缀，避免同机多账号串台：`goodpuppy.onlineNotify.<selfId>`。
- v1 不入库；若后续要跨设备同步再考虑 DB 列（记入新 ADR）。

## 9. 平台差异表

| 关注点 | macOS | Windows |
|---|---|---|
| 可用区 | `NSScreen.visibleFrame`（objc2-app-kit） | `GetMonitorInfo.rcWork`（windows-sys） |
| 弹出位置 | 目标屏右上 | 目标屏右下（taskbar 上方） |
| 全屏检测 | 活动 Space / `isOnActiveSpace` | `SHQueryUserNotificationState` |
| 恢复补弹 | `NSWorkspaceActiveSpaceDidChange` | 轮询通知状态 |
| 浮层级别 | `configure_floating_overlay`（popup 级，不入 all Spaces） | 置顶 topmost |
| 全屏覆盖 | v1 不覆盖（排队） | v1 不覆盖独占全屏（排队） |

## 10. 测试计划

- **纯逻辑单测（Vitest，优先）**：
  - 上线检测去重/初次 sync 过滤/自己过滤（抽成不依赖网络的纯函数）。
  - 订阅开关 localStorage 读写、按账号隔离、房间退出清理。
  - 弹窗队列：可弹/不可弹分支、堆叠上限、出队重排（注入 `can_show_notification` 假实现）。
  - 卡片定位计算：给定 work area + 目标屏 + 序号 → 期望坐标（Mac 右上 / Win 右下）。
- **构建**：`npm run test`、`npm run build`。
- **桌面手测（`npm run tauri dev`）**：
  - 双账号：B 进房间，A 收到 toast，点击进入走通。
  - 多屏：光标在副屏时弹副屏正确角落。
  - Mac 全屏：A 在全屏 Space 时不弹、退出后补弹；计时不在全屏期间流逝。
  - Win：taskbar 上方正确定位；全屏视频/游戏时排队补弹。
  - 订阅持久：开开关 → Lounge 收托盘 → 仍能弹；关开关后不弹。
  - 置顶/穿透/命中不受影响（toast 不抢焦点、不破坏 pet 交互）。

## 11. 不做（YAGNI，v1）

- 真·全屏覆盖（v2，单独立项 + 重测 Mac Space/销毁）。
- 真人头像上传（avatar_url + Storage + UI）。
- 「仅登录未进房」上线检测。
- 通知历史/中心、自定义声音、免打扰时段、点击「查看」打开 Lounge 并定位房间（可选项，非必需）。

## 12. 未决 / v2 候选

- 是否需要轻量声音提示（v1 可先静默或一声系统提示音）。
- 是否给「进入房间」之外再加「查看」（打开 Lounge 聚焦该房间但不进房）。
- 全屏覆盖（方案 2）：仅给 toast 窗设 `CanJoinAllSpaces + FullScreenAuxiliary`，需重点验证 Mac Space 成员关系与销毁稳定性。
- 跨设备订阅同步（DB 列 + RLS + ADR）。
