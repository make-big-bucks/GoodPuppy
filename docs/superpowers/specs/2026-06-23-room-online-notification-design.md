# 设计文档：房间上线提醒（自绘 Toast 提示窗）

- 日期：2026-06-23（决策更新 2026-06-24）
- 状态：已确定决策，待实现
- 相关 ADR：`docs/adr/0001-tauri-替代-electron.md`、`docs/adr/0004-前端-webview-承担业务逻辑.md`、`docs/adr/0008-分层动画状态机与实时事件.md`
- 相关代码：`src/windows/pet/roomManager.ts`、`src/windows/lounge/lounge.ts`、`src/windows/lounge/loungeViewModels.ts`、`src-tauri/src/commands.rs`、`src-tauri/src/platform.rs`、`src/shared/bridge.ts`、`docs/database.md`

## 0. 决策记录（2026-06-24 评审）

代码核对后确定以下取舍，覆盖正文中早期假设：

1. **上线信号源 = 复用现有 DB `presence` 表的 Realtime 订阅**，不另建 `presence:${roomId}` broadcast 频道。
   - 理由：pet 进房时已 `upsert` DB `presence`（`roomManager.ts:133`，带心跳）；Lounge 已订阅该表 `postgres_changes`（`lounge.ts:1120`，频道 `lounge-presence-${selfAuthId}`）。一条订阅覆盖全部房间、天然受 RLS 保护。
   - 代价：DB 行无 `pet_id`/`skin`，形象与名字均由 Lounge 已有的 `profiles` 缓存解析（`pet_id`/`skin`/`display_name` 列已在查询中，见 `lounge.ts:642`/`:660`）；无「实时换肤」，v1 接受。
   - 「刚上线」需自维护快照对比（见 §5.2），因为 `postgres_changes` 的 `old` 默认只含主键。
2. **当前所在房间不提醒**：只对「非当前 active room」的订阅房间弹 toast（自己房里 pet 本就会出现）。
3. **订阅开关默认关闭**（opt-in）：用户主动为关心的房间开启。
4. **macOS 全屏 v1 靠自然隐藏 + 轮询补弹**：不实现精确全屏 Space 判定；toast 与 pet 一样不加入 all Spaces，全屏 Space 下本就不显示，spawn 后轮询自身可见性/`isOnActiveSpace`，不可见则挂起、恢复后补弹。`can_show_notification` 简化或省略（见 §5.4）。

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
- 常驻 Lounge 窗口承载上线检测与去重（复用现有 DB `presence` Realtime 订阅 + 快照 diff）。
- 按房间持久订阅开关（默认关闭，localStorage 按账号隔离）。
- 自绘 Toast 窗口：spawn、UI、定位、自动消失、手动关闭、点击进入。
- 新增 native 命令：按指定显示器取 work area；`spawn_toast_window`/`close_toast_window`；（Windows 可选）全屏/演示检测。
- 全屏排队：检测到不可见/全屏时挂起，恢复可见后补弹。

### Out of scope（v1 不做，见 §11）

- 真·浮在他人全屏之上（v2，需重测 Mac Space/销毁逻辑）。
- 真人头像（avatar_url + Storage），v1 一律用宠物形象。
- 「对方仅登录、未进任何房间」的检测。
- 提醒历史/通知中心、声音自定义、免打扰时段。

## 3. 名词与语义

- **上线**：某用户在 DB `presence` 表上发生「进入某房间」的状态跃迁——即该用户行从「非（在房间 R 在线）」变为 `is_online = true && current_room_id = R`。沿用现有写入语义（pet 进房 `upsert is_online/current_room_id`，见 `roomManager.ts:133`；退房置 `is_online=false, current_room_id=null`）。「仅登录未进房」不算上线、不提醒。
- **订阅**：用户在 Lounge 对某房间打开「上线提醒」开关。**默认关闭**，开启后是**持久**状态：即便 Lounge 隐藏（托盘）后台仍监听；关闭或退出 App 才停止。
- **当前房间**：用户自己 pet 正在的房间（`activeRoomId`）。**当前房间内的上线不提醒**。
- **提示窗 / Toast**：一次性 spawn 的独立置顶窗口，承载一张卡片，可自动消失或手动关闭。

## 4. 架构总览

```
┌────────────────────────── 常驻 Lounge 窗口（webview，永不销毁） ──────────────────────────┐
│  既有：supabase 会话、房间/成员/profile 数据、presence 一次性 fetch                        │
│                                                                                          │
│  新增 onlineNotifier 模块：                                                               │
│   - 订阅开关：读/写 localStorage（默认关闭），决定哪些房间参与提醒                         │
│   - 上线检测：复用 DB presence 表 Realtime（postgres_changes）+ 自维护快照 diff →          │
│       识别「进入订阅房间且非当前房间、非自己」的状态跃迁 → 产出「上线事件」                │
│   - 弹窗调度：可见性判定 → 可则 spawn toast；不可（全屏/隐藏）则入队，恢复后补弹           │
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
  - spawn_toast_window / close_toast_window → 仿 spawn_pet_window
  - （Windows 可选）can_show_notification() → SHQueryUserNotificationState 全屏/演示检测
  - macOS 全屏不实现精确判定，靠 toast 自身可见性轮询（§5.4、§7）
```

**为什么宿主放 Lounge**：`main`（pet）与 `lounge` 都是启动即创建、关闭/登出仅 `hide()` 永不销毁的窗口（见 `src-tauri/src/lib.rs:131`、`:156`）。只要 App 运行，**Lounge 的 JS 一直在跑**，且它已持有 supabase 会话、全部房间/profile 数据，以及对 DB `presence` 表的 Realtime 订阅。pet 在「未登录/未进房」时是 hidden，不能承载后台订阅与弹窗。故订阅与调度放 Lounge，Toast 用独立窗口，**不依赖 pet 是否可见**。

## 5. 组件详述

### 5.1 订阅管理（`src/windows/lounge/onlineNotifier.ts`，新增）

- 职责：维护「房间 → 是否订阅」集合（持久于 localStorage，默认关闭），并持有上线检测所需的 presence 快照与调度状态。
- 输入：当前用户房间列表与成员 profile（Lounge 已有 `rooms` / `profiles` 缓存）、当前 `activeRoomId`、selfId。
- 接口：
  - `initOnlineNotifier({ supabase, getRooms, getProfiles, getActiveRoomId, getSelfId })`：启动；读已存开关，拉一次 presence 快照作为基线。
  - `setRoomSubscribed(roomId, on)`：开/关单房间，落 localStorage。开关不影响订阅本身（订阅是全局一条，见下），只影响是否对该房间产出事件。
  - `isRoomSubscribed(roomId): boolean`：供 UI 渲染开关态（默认 `false`）。
  - `onPresenceChange(row)`：由 Lounge 的 presence `postgres_changes` 回调转发进来（见 5.2），驱动上线检测。
  - `disposeOnlineNotifier()`：登出/退出时清理快照、队列与所有 toast 窗口。
- **不新建 Realtime 频道**：复用 Lounge 已有的 `lounge-presence-${selfAuthId}` 订阅（`lounge.ts:1120`）。在该回调里，除既有 `loadPanelData()` 外，把变更行转交 `onlineNotifier.onPresenceChange(payload.new)`。
- 房间列表变化（加入/退出房间）时同步：对已不属于自己的房间清除其订阅开关与快照条目。

### 5.2 上线检测与去重

- **快照**：模块内维护 `Map<userId, { isOnline, roomId }>`，初始由一次 `presence` 全量 fetch 填充（基线，等价于「订阅前已在线的人不算刚上线」）。
- 每次收到 presence 行变更 `{ user_id, current_room_id, is_online, last_seen }`：
  1. 计算该用户的「新状态」`now = is_online ? roomId : null`，与快照里的「旧状态」`prev` 对比。
  2. 命中**上线事件**的条件（全部满足）：
     - `now` 是某个具体房间 R（`is_online && current_room_id`）。
     - `prev` 不是同一个房间 R（首次在线、或从别的房间切过来）。
     - R 已被订阅（`isRoomSubscribed(R)`）。
     - `user_id !== selfId`。
     - `R !== activeRoomId`（当前所在房间不提醒）。
  3. 更新快照为 `now`（无论是否产出事件）。
  4. 去抖：同一 `(roomId, userId)` 在 N 秒（默认 10s）内重复上线（心跳/断线重连导致的连续 update）只提示一次。
- 输出「上线事件」`{ roomId, roomName, userId, displayName, petId, skin }`。`displayName`/`petId`/`skin` 由 Lounge 已有的 `profiles` 缓存解析（改名/换肤随 profile 自动跟随，缺失时回退 gp_id 末位标签，复用 `loungeViewModels.getDisplayName`）。`roomName` 取自 `rooms` 缓存。

> 注：DB `presence` 行不含 `pet_id`/`skin`，故形象用 profile 上的值（账号级），与「实时换肤」可能短暂不一致，v1 接受（§0 决策 1）。

### 5.3 弹窗调度与 Toast 窗口

**调度**：

1. 收到上线事件 → 决定目标显示器（§7 多屏）。
2. 判定「现在能否弹」：
   - macOS：不做精确全屏判定，直接取该屏 work area、计算位置、`spawn_toast_window`，**spawn 后轮询 toast 自身 `isOnActiveSpace`/可见性**；若不可见（落在全屏 Space 之外）则视为「未真正展示」，挂起入队、暂不计时，恢复后补弹（§7）。
   - Windows（可选增强）：先 `can_show_notification`（`SHQueryUserNotificationState`），不可弹则入**待弹队列**，轮询恢复后补弹。
3. 多条并存时纵向堆叠（Mac 自上而下、Win 自下而上），最多同时显示 K 条（默认 3），超出排队。

**Toast 窗口**（`windows/toast.html` + `src/windows/toast/toast-main.ts`，新增）：

- 透明窗口 + 内部不透明圆角卡片（沿用 bubble 窗的「透明窗画不透明内容」做法，保证圆角干净）。置顶、`skipTaskbar`、不抢焦点（不激活 App）。
- macOS 套用 `configure_floating_overlay`（popup 级、不加入 all Spaces——与 pet 一致，故全屏时本就不显示，配合 §7 排队）。
- 内容：宠物静态形象（`public/pets/<petId>/skins/<skin>/` 解析，`petId`/`skin` 来自 profile 缓存，复用 `animationCatalog` 的皮肤路径逻辑取一帧静态图）、名字、房间名、主按钮「进入房间」、关闭「×」。
- 生命周期：
  - 自动消失：默认 8s。**计时仅在窗口实际可见后开始**（§7：被全屏遮挡时不计时）。
  - 手动关闭：点「×」立即关闭。
  - 点「进入房间」：回传 Lounge → `emit("switch-room", {roomId})`（现有流程，`lounge-main.ts:142`），随后关闭 toast 并显示 Lounge/pet。
  - 关闭即 `close_toast_window` 回收，触发堆叠重排与队列出队。

### 5.4 Native 命令（`src-tauri/src/commands.rs` + `platform.rs`，薄层）

- `get_monitor_work_area(monitor_index: Option<usize>) -> Rect`：
  - macOS：对应 `NSScreen` 的 `visibleFrame`（已依赖 `objc2-app-kit`），换算逻辑像素。修正现有 `getMonitorWorkArea` 实为整屏的问题（`src/shared/bridge.ts:46` 用了 `monitor.size` 未扣 dock/菜单栏）。
  - Windows：`MonitorFromPoint`/枚举 + `GetMonitorInfo` 的 `rcWork`（已依赖 `windows-sys`，需启用 `Win32_Graphics_Gdi` / `Win32_UI_WindowsAndMessaging` 等 feature）。
- `can_show_notification() -> bool`（**仅 Windows 实现，macOS 直接返回 true**，见 §0 决策 4）：
  - Windows：`SHQueryUserNotificationState`，遇 `QUNS_BUSY`/`QUNS_RUNNING_D3D_FULL_SCREEN`/`QUNS_PRESENTATION_MODE`/`QUNS_NOT_PRESENT` 视为不可弹。
  - macOS：不实现精确全屏 Space 判定；调度侧改为 spawn 后轮询 toast 自身可见性/`isOnActiveSpace`（前端 `Window.isVisible()` / 监听 Space 变化），不可见即挂起补弹。
- `spawn_toast_window` / `close_toast_window`：仿 `spawn_pet_window`（`commands.rs:59`）。窗口 label 形如 `toast-<seq>`。

> 平台差异遵循 CLAUDE.md：Rust 侧用 `#[cfg(target_os = ...)]` 隔离；不引入仅 Mac 行为到前端。

### 5.5 进入房间动作流

Toast「进入房间」→ Toast 窗 `emit` 给 Lounge（带 roomId）→ Lounge 调既有 `onEnterRoom(roomId)` / `emit("switch-room", {roomId})`（`lounge-main.ts:141`）→ pet 协调者进房、显示 pet，Lounge 按现有逻辑隐藏。**不新增进房路径，纯复用。**

## 6. 数据流（时序）

```
用户B 进入房间R（其 pet upsert DB presence: is_online=true, current_room_id=R）
        │ Supabase Realtime（presence 表 postgres_changes）
        ▼
用户A 的 Lounge：lounge-presence 订阅回调 → onlineNotifier.onPresenceChange(row)
        ▼
快照 diff：prev≠R 且 now=R 且 R 已订阅 且 B≠self 且 R≠activeRoom 且 未去抖
        ▼
产出上线事件 {R, roomName, B, displayName, petId, skin}（名字/形象取 profiles 缓存）
        ▼
可弹判定？
   ├─ 可 → get_monitor_work_area → 计算位置 → spawn_toast_window
   │        → 轮询确认可见 → 起 8s 计时
   └─ 不可（全屏/隐藏）→ 入待弹队列 → 监听恢复 → 恢复后逐条补弹
        ▼
用户A 点「进入房间」 → emit switch-room → 进房间（现有流程） → 关闭 toast
```

## 7. 边界情况

- **多显示器**：目标屏取「光标当前所在屏」（复用 `src-tauri/src/cursor.rs` 的原生光标采样；无则退化主屏）。`availableMonitors()` 定位，`get_monitor_work_area(index)` 取该屏可用区。
- **当前所在房间**：`R === activeRoomId` 时不提醒（§0 决策 2）。`activeRoomId` 由 Lounge 已维护（`lounge-main.ts` 的 `active-room-changed`），onlineNotifier 经 `getActiveRoomId()` 读取。
- **全屏（Mac 为主）**：v1 **不覆盖全屏**。toast 与 pet 同为不加入 all Spaces 的普通窗口，全屏 Space 下本就不显示；调度侧 spawn 后轮询确认可见，不可见即挂起，恢复信号：
  - macOS：监听活动 Space 变化（`NSWorkspaceActiveSpaceDidChangeNotification`，或轮询 toast `isVisible`/`isOnActiveSpace`）。
  - Windows：恢复信号轮询 `SHQueryUserNotificationState` 回到 `QUNS_ACCEPTS_NOTIFICATIONS`。
  - 自动消失计时仅在确认可见后开始，避免「全屏期间静默过期」。
- **Windows 独占全屏游戏**：`SHQueryUserNotificationState` 报全屏 → 排队，退出后补弹；不强弹、不闪烁。
- **多条 toast**：纵向堆叠，最多 K 条同时显示，超出排队；某条关闭后重排并出队。
- **自己**：始终过滤，自己进房不提醒。
- **离线/断线重连 / 心跳**：去抖窗口（默认 10s）内同一 `(room,user)` 的重复上线/心跳 update 不重复提示。
- **改名 / 换肤**：名字与形象（`pet_id`/`skin`）均由 profile 缓存解析；profile 变化时 Lounge 已 `loadPanelData`，下次事件自动跟随。
- **房间退出 / 被移除**：同步清除该房间的订阅开关与快照条目；该房间不再产出事件。
- **未登录**：无 supabase 会话时不初始化 notifier；登录后随 Lounge auth 流程初始化。

## 8. 持久化

- 订阅开关存 localStorage，**按账号隔离**，键为 `goodpuppy.onlineNotify.<selfId>`，值为「已开启提醒的 `roomId[]`」（JSON）。
- **默认关闭**：房间不在数组里即视为未订阅（opt-in，§0 决策 3）。
- v1 不入库；若后续要跨设备同步再考虑 DB 列（记入新 ADR）。

## 9. 平台差异表

| 关注点 | macOS | Windows |
|---|---|---|
| 可用区 | `NSScreen.visibleFrame`（objc2-app-kit） | `GetMonitorInfo.rcWork`（windows-sys） |
| 弹出位置 | 目标屏右上 | 目标屏右下（taskbar 上方） |
| 全屏检测 | 不精确判定；spawn 后轮询 toast `isVisible`/`isOnActiveSpace` | `SHQueryUserNotificationState`（可选） |
| 恢复补弹 | `NSWorkspaceActiveSpaceDidChange` / 轮询可见性 | 轮询通知状态 |
| 浮层级别 | `configure_floating_overlay`（popup 级，不入 all Spaces） | 置顶 topmost |
| 全屏覆盖 | v1 不覆盖（排队） | v1 不覆盖独占全屏（排队） |

## 10. 测试计划

- **纯逻辑单测（Vitest，优先）**：
  - 上线检测：快照 diff（首次在线 / 切房间 / 同房间心跳重复）、自己过滤、当前房间过滤、未订阅过滤、去抖（抽成不依赖网络的纯函数，喂 presence 行序列）。
  - 订阅开关 localStorage 读写、默认关闭、按账号隔离、房间退出清理。
  - 弹窗队列：可弹/不可弹分支、堆叠上限、出队重排（注入可见性判定假实现）。
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
