# 多窗口独立桌宠 · Phase B 设计

- 日期：2026-06-17
- 状态：待评审
- 关联：取代 [ADR-0007 单窗口 presence 渲染](../../adr/0007-单窗口-presence-渲染.md)（实现后补写新 ADR）；后续 [Phase A 设计](2026-06-17-多窗口独立桌宠-phaseA-design.md)

## 背景与目标

当前 MVP 采用单窗口动态多 pet 渲染（ADR-0007）：自己的 pet 与所有远程成员 pet 都渲染在同一个透明置顶窗口（`main`）内，窗口随成员数横向撑宽、随气泡纵向增高。该模型在物理上**无法让每只 pet 独立拖动**——它们共享一个窗口，拖一个就拖全部。

目标是把同房间的多个成员 pet 拆成**各自独立、可分别拖动的窗口**，让"桌面上散落着朋友们"的氛围感成立。需求确认：

- 范围：**同房间成员**（自己 + N 个在线远程成员），不涉及"单用户多只自有 pet"。
- 定位：同时支持**完全自由**（用户任意拖放、记忆位置）与**半自由**（远程 pet 自动排布、不可单独拖）两种模式，设置中可切换。完全自由是半自由的超集。
- 位置记忆：远程 pet 按 **(房间 + 成员)** 记忆；自己的 pet 全局记忆上次位置。
- 气泡：Phase B 仍留在各自 pet 窗口内（升级为独立子窗口见 Phase A）。

### 为什么先做 B

B 期已交付核心诉求"独立、可分别拖动的桌宠"，且只动前端 + 少量 Rust，风险低，能尽早验证多窗口在 **macOS 全屏 Space + 多屏**下是否稳定——这才是真正要先趟的未知数。气泡升级为原生子窗口（唯一新增原生复杂度）留到 A 期，那时多屏、动态生命周期都已踩实。

## 现状关键事实（代码层）

- macOS NSPanel 逻辑（`configure_macos_overlay_level`、`GoodPuppyPanel`、`macos_overlay_collection_behavior`，`src-tauri/src/lib.rs`）**隔离良好**：setup 时对 `main` 调用一次，前端零感知，是"配置一次就忘"的固有复杂度，不是干扰性复杂度。它已是按窗口复用的纯函数，套到新窗口的边际成本低。
- 真正盘根错节的是**单窗口假设**，集中在前端：
  - `renderer.ts` 模块级单例（`selfAnimator`/`selfArea`/`currentLayout`/穿透状态等）。
  - `applyWindowLayout`（renderer.ts:185，约 75 行）横向撑宽 + 纵向增高 + 翻转 + 反锚点补偿 + 串行化。
  - 穿透是窗口级（`cursorEventsController` 单一 `appliedIgnore`），`isInteractiveAt` 在一个 document 里扫所有 `.dog-area` 与气泡区。
  - Rust 光标监视器写死只服务 `main`（lib.rs:309 `if label != "main" continue`）。
  - 消息路由 `areaForSender` 在同一 document 里按 sender 查 DOM。
- `set_window_bounds`（lib.rs:376）算 Cocoa Y 翻转时**写死主屏高度**——多屏 + 自由摆放下会算错。

## 架构：协调者 / 呈现者

### 窗口拓扑
- `lounge` 不变。
- `main` 窗口**降级为"自己的 pet 窗口 + 房间协调者"**（房间内始终存在，天然适合当协调者）。
- 每个在线远程成员 = 一个**动态创建**的透明 NSPanel 窗口，label `pet-<userId>`，加载 `pet.html` 的"单 pet 模式"（URL 参数 `?role=remote&userId=...&room=...`）。

### 命门：一份订阅，集中协调
**绝不让 N 个窗口各自订阅同一房间的 presence/realtime**（会重复订阅、状态竞态）。

**协调者（自己的 pet 窗口）独占所有 Supabase 订阅**：
- 订阅 presence / messages / interactions（移植现 `roomManager` 逻辑）。
- presence 变化时 diff 在线成员 → 调 Rust `spawn_pet_window` / `close_pet_window`。
- 把每只远程 pet 需要的数据用 Tauri `emit_to(label, ...)` **定向转发**：情绪/工作状态、皮肤、petId、消息、被互动事件。
- 管理位置持久化（房间+成员）与"自由/半自由"模式。

**每个远程 pet 窗口是"哑呈现者"**，不碰 Supabase：
- 收协调者转发事件 → 播动画、渲染自己的气泡。
- 自己处理拖动、穿透、像素命中（renderer 退化为只服务一只 pet）。
- 拖动结束上报新位置给协调者持久化。

自己的 pet 窗口 = 协调者 + 自己的呈现者两顶帽子，复用同一份 renderer。

收益：订阅唯一、数据单一来源、无 N 窗口竞态；远程窗口无网络逻辑、崩了/重建廉价、生命周期 = presence 直接映射；符合 ADR-0004。

## 生命周期

| 触发 | 协调者动作 | Rust 动作 |
|---|---|---|
| 进房间 | 显示自己窗口；订阅 presence；对每个在线远程成员算初始位置后 spawn | 建窗 → `configure_macos_overlay_level` → 定位 → 加载单 pet 模式 |
| 成员上线 | 算位置 → `spawn_pet_window` | 同上 |
| 成员离线 | `emit_to(label, "pet-leave")`，按 manifest 退场时长延时后 `close_pet_window` | 销毁窗口 |
| 退房间/登出 | 关闭所有远程 pet 窗口；隐藏自己窗口 | 批量销毁 |

退场动画在窗口内播完再销毁（对应现 `applyPresence` 中 leave 的节奏，"移除 DOM"换成"关窗口"）。

## 跨窗口通信（Tauri event，按 label 定向）

- **协调者 → pet 窗口**：`pet-state`（情绪/工作/皮肤/petId）、`pet-message`（单条/历史）、`pet-interaction`（被戳等）、`pet-leave`。
- **pet 窗口 → 协调者**：`pet-moved`（拖动结束上报位置）、`pet-interact-request`（要戳谁——由协调者统一经 Supabase 广播，呈现者不碰网络）。

消息路由由"同 document `areaForSender` 查 DOM"改为"协调者按 userId `emit_to` 对应窗口"。历史消息缓存（`roomMessageCache`）留在协调者，新窗口创建后把该成员历史 `emit_to` 补齐（对应现 `onRemotePetCreated` 回填）。

## 定位与持久化

- **存储**：localStorage。远程键 `pet-pos:<roomId>:<userId>`，自己键 `pet-pos:self`（全局）。存逻辑像素坐标。
- **完全自由**：每窗口原生 `startDragging()` 可拖；拖完上报，协调者按键写盘。spawn 时有存档则还原，无则自动摆位（自己 pet 附近横向偏移兜底）。
- **半自由**：远程窗口**禁用拖动**（呈现者不调 `startDragging`）；协调者算自动排布（沿屏幕底边 / 自己 pet 旁一字排开）并 `set_window_bounds` 摆好；自己的 pet 仍可自由拖。
- **模式开关**：存 preferences（同 scale/skin），入口在自己 pet 右键菜单（"自由摆放 / 自动排布"）。切换时协调者重排：切半自由→套自动布局；切自由→还原各自存档。

## 多屏修正（Phase B 必做）

气泡在窗口内增高仍要调 `set_window_bounds`，而自由模式下 pet 可能在副屏——`set_window_bounds`（lib.rs:376）写死主屏高度算 Cocoa Y 必须改为**按目标窗口所在屏幕换算**（取窗口当前 frame 所在的 `NSScreen`，用该屏 frame 做 Y 翻转）。否则副屏上 pet 一弹气泡就跳位。

## 代码改动面

### 前端 · 拆除/简化
- `petLayout.ts`：删横向撑宽（`getPetWindowLayout` 按数量加宽、`PET_SLOT_WIDTH`、`orderRemotePetIds` 槽位排序）；保留纵向气泡增高/翻转，但只服务本窗口一只 pet。
- `remotePets.ts`：DOM 增删 + `relayoutRemotePets` 横向 slotting 整体退役，迁到协调者窗口生命周期管理。
- `renderer.ts`：瘦身为"单 pet 呈现器"，按 URL 参数判定 self/remote；`applyWindowLayout` 去横向、去 `getRemotePetCount`，只管本窗口纵向。
- 消息路由：`areaForSender` → 协调者 `emit_to`；气泡渲染本身不变。

### 前端 · 新增
- `roomCoordinator.ts`：在自己窗口里订阅 presence/messages/interactions（移植现 `roomManager` 订阅）、diff 成员→spawn/close、`emit_to` 转发、持久化策略 + 模式。
- `petPositionStore.ts`：(房间+成员)/self 位置读写。
- `bridge.ts`：加 `spawnPetWindow` / `closePetWindow` / `emitToWindow` / 上报位置封装。

### Rust（`src-tauri/src/lib.rs`）
- `spawn_pet_window(label, role, user_id, room_id, x, y)`：`WebviewWindowBuilder` 建透明 panel → `configure_macos_overlay_level` → 定位。**需在 capabilities 覆盖动态窗口**（核对 `src-tauri/capabilities/*.json`，ADR-0005 当年点过此坑）。
- `close_pet_window(label)`。
- `set_window_bounds`：改多屏坐标换算。
- 光标监视器：把 `if label != "main"`（lib.rs:309）改为"服务所有 pet 窗口"（按 label 前缀或受管集合，排除 lounge）；`pet-drag-ended` 广播给所有 pet 窗口，各窗口自判是否在拖。

## 模块边界自检

- **协调者**：输入 = Supabase 订阅 + pet 窗口上报；输出 = spawn/close 指令 + `emit_to` 数据 + 位置写盘。可独立测：给定 presence 序列，断言 spawn/close 调用与转发 payload。
- **呈现者（pet 窗口）**：输入 = URL 参数 + 协调者事件；输出 = 动画/气泡渲染 + 位置上报。无网络依赖，可用事件桩测试。
- **petPositionStore**：纯 localStorage 读写，键规则可单测。
- **多屏坐标换算**：抽成纯函数（屏幕 frame + 逻辑坐标 → Cocoa frame），补 lib.rs tests。

## 验证策略

- 单测：`petPositionStore`（键/还原）、模式切换的自动布局计算、多屏 Cocoa Y 换算纯函数、`petLayout` 瘦身后回归。
- `npm run tauri dev` 手验：双屏拖动 + 副屏弹气泡不跳位、全屏 Space 下多窗口都在、成员上下线 spawn/close、每个窗口穿透准确、模式切换重排、原生拖动 drag-lift/drag-end 正常。
- 文档：实现后新增 ADR 取代 0007（多窗口回归 + 协调者模型），更新窗口/布局相关说明。

## 不在本期范围（YAGNI）

- 气泡升级为原生子窗口 → Phase A。
- 单用户多只自有 pet。
- 复杂避让 / 自动防重叠布局（半自由用简单一字排开即可）。
