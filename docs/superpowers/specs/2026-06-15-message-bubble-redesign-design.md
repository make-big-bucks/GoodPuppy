# 消息气泡重设计方案

日期：2026-06-15
状态：已通过设计评审，待写实现计划

## 背景与目标

当前消息气泡（`src/windows/pet/messageBubble.ts` + `src/shared/styles.css` 中 `.message-bubble`）存在以下特征：

- 使用图片资源 `public/img/cloud_transparent.png` 作为气泡背景，命中测试按该图 alpha 采样（`renderer.ts` 的 `cloudHitImage`）。
- 单条消息 + 上一条/下一条导航（`bubble-prev` / `bubble-next`），而非堆叠。
- 写消息的 composer 内嵌在气泡内部（`bubble-composer`）。
- 远程宠物气泡只显示占位文本「在线」（`remotePets.ts` 的 `showRemoteBubble`），不展示真实消息。
- 气泡固定位于 `.dog-area`（高 220px、`bottom:0`）顶部，宠物移到屏幕顶端时气泡会溢出屏幕。

本次目标：

1. 用纯代码（CSS）绘制气泡，弃用图片资源。
2. 把单条+导航模型改为**每只宠物头上一个垂直滚动的气泡堆叠**，每只宠物只显示其主人发的消息。
3. 气泡随宠物在屏幕中的位置做边缘响应（顶部空间不足时整组翻到宠物下方）。
4. 提供「关闭气泡」交互（悬浮浮现，按宠物各自关闭，仅隐藏不删除）。
5. 把写消息 composer 重做为头顶的「记号棒」输入条（仅自己可用）。
6. 无气泡 / 气泡关闭时，窗口不为气泡预留空间，缩回到仅容纳宠物动画。

架构原则沿用 CLAUDE.md：保持单窗口、业务逻辑在前端、Rust 薄层、双平台兼容、窗口层级/定位改动谨慎。

## 已确认的关键决策

- **窗口架构**：沿用单窗口、每只宠物一个 `.dog-area`，气泡仍是其内部 DOM；不拆分独立气泡窗口。
- **消息归属**：各说各的——每只宠物头上只堆叠该宠物主人发的消息。
- **边缘响应**：顶部空间不足时，整组气泡翻到宠物下方（`.is-flipped`），最新消息仍贴近头部。
- **容量**：每只宠物内存保留最近约 20 条；可见区高度有限，超出靠滚动。
- **关闭范围**：每只宠物各自关闭（悬浮该宠物气泡区才浮现关闭按钮）。
- **气泡形状**：圆角矩形；**仅最贴近宠物头部的那条**带指向头的小尾巴，其余气泡为纯圆角矩形。
- **堆叠空间**：宠物上、下方各预留约 3 条气泡高度（约 180px），再多靠滚动。
- **滚动策略**：先做简单版「新消息总是滚到底」，不处理"用户正在翻历史时被打断"。
- **记号棒**：仅自己宠物可用（远程宠物右键无「写消息」，与现状一致）。
- **窗口动态高度**：无可见气泡时窗口仅容纳宠物本身；有可见气泡时才增高。

## 组件设计

### 1. DOM 结构（`windows/pet.html` 与 `remotePets.ts` 动态模板）

每只宠物的 `.dog-area` 改为：

```
.dog-area
  ├─ .bubble-stack                 新：垂直堆叠容器，可滚动；含关闭按钮
  │    ├─ button.bubble-close       悬浮浮现，关闭本宠物堆叠
  │    ├─ .bubble                    最旧，在上（纯圆角矩形）
  │    └─ .bubble.has-tail           最新，贴近头（带尾巴）
  ├─ .compose-stick                新：记号棒输入条（仅 self 模板含此节点）
  │    ├─ textarea.compose-input
  │    ├─ button.compose-cancel (✕)
  │    └─ button.compose-send  (✓)
  └─ img.pet-image
```

self 与 remote 模板的差异：remote 模板不含 `.compose-stick`。

### 2. 代码绘制气泡（`styles.css`）

- `.bubble`：半透明白底、圆角矩形、细描边、轻微阴影；颜色复用 `tokens.css`（`--gp-pet-ink` 等）。删除 `background-image: url(cloud_transparent.png)` 及相关 `.message-alert` 旧样式按需保留/精简。
- `.bubble.has-tail`：用 `::after`（border 三角或 `clip-path`）画指向宠物头的小尾巴。默认尾巴朝下（气泡在头上方）；`.dog-area.is-flipped` 时尾巴朝上。
- `.has-tail` 始终标记在**最贴近宠物头部**的那条气泡上：向上堆叠时是底部那条，翻转向下堆叠时是顶部那条。新增消息或翻转时重算该标记。
- 命中测试：弃用 cloud 图 alpha 采样，改为矩形包围盒判定（`renderer.ts` 已有 `isPointInsideElement`）；删除 `cloudHitImage` 及其加载逻辑。

### 3. 栈式渲染模块（重写 `messageBubble.ts`，扩展 `messageLog.ts`）

`messageLog.ts`（纯逻辑，保留并扩展）：

- 保留 `normalizeMessage` / `sortByTime` / `buildMessageList` / `insertMessage`。
- 新增容量裁剪：`MAX_STACK = 20`，插入后裁剪到最近 20 条。
- 移除仅服务于单条导航的 `canShowPrevious` / `canShowNext`（栈模型不再需要），或保留备用——实现时按需删除。

新的栈渲染模块对外提供（按 `.dog-area` 维度操作，支持多实例）：

- `mountBubbleStack(area)`：绑定某宠物的堆叠容器与事件。
- `addMessage(area, message)`：插入、裁剪、渲染、自动滚到底；若该区处于 `bubbles-dismissed` 则先清除该标记重新展开。
- `setMessages(area, messages)`：初始化历史。
- `dismiss(area)`：加 `.bubbles-dismissed`，隐藏堆叠（消息保留）。
- 渲染后调用 `onRefreshPassthrough` 与窗口高度重算。

### 4. 窗口动态高度 + 边缘翻转（`petLayout.ts` / `petDrag.ts` / `bridge.ts` / `renderer.ts`）

空间常量：上、下方堆叠区各 `STACK_SPACE ≈ 180px`（约 3 条气泡）。

窗口高度策略（窗口为所有宠物共享，垂直同处一个 band，故翻转与高度决策对整窗口统一）：

- 无任何宠物有可见气泡（无消息或全部 dismissed）→ 窗口高度 = 仅宠物动画（约等于现有 `PET_WINDOW_HEIGHT`，可下调到贴合宠物本身）。
- 有任意宠物有可见气泡 → 窗口在宠物所在 band 之外增加 `STACK_SPACE`：默认向上增高（气泡向上堆叠）。
- 当窗口顶部贴近/超出屏幕可用区顶部 → 改为向下增高并给 `.dog-area` 加 `.is-flipped`（气泡翻到宠物下方）。

位置补偿：增高/缩回与翻转时，必须 `setWindowPosition` 补偿，使**宠物视觉位置不变**，且不破坏现有拖动手感与落点。`petLayout.ts` 的高度/锚点与 `petDrag.ts` 的定位数学相应调整：宠物锚定改为相对一个可变的 band，而非恒定 `bottom:0`。

边缘检测数据：

- 复用 `bridge.getWindowPosition()`（真实屏幕坐标）。
- 新增 `bridge.getMonitorWorkArea()`：基于 Tauri `currentMonitor()` 返回可用区尺寸/位置；替换 `getWindowLayout()` 中写死的 `150×220` 假值。Rust 侧保持薄层，优先用前端 `@tauri-apps/api/window` 的 `currentMonitor()`。

### 5. 数据层：房间级消息路由（`selfMessages.ts` → 房间订阅）

- 拉取房间最近消息，按 `sender_id` 分组、每人保留最近 20 条 `kind=text`。
- 订阅房间内**所有** `text` 消息的 INSERT（不再过滤 `sender_id=self`）。
- 路由：`sender_id === selfAuthId` → self 堆叠；`sender_id` 匹配某在线远程宠物 → 该宠物堆叠；匹配不到（未在房间渲染的发送者）→ 忽略。
- 远程宠物的「在线」占位（`remotePets.ts` `showRemoteBubble`）由真实消息堆叠取代；进场初始化、离场清理其堆叠。
- 不涉及数据库表结构/RLS 改动（仍读 `messages` 表），仅订阅范围变化；在设计文档记录，无需新建迁移。`docs/database.md` 如有"消息可见范围"描述需同步措辞。

### 6. 记号棒（重做 composer，`contextMenu.ts` 触发，仅 self）

- 右键菜单「写消息」`onWriteMessage` → 在自己宠物头顶展开 `.compose-stick`（举牌/木牌造型：圆角条 + 可选小木杆装饰），`textarea` 聚焦可输入。
- 右侧 icon：发送 ✓ / 取消 ✕，复用现有 `onSubmitMessage` 行为与发送中/失败状态提示。
- 发送成功 → 消息进入自己的堆叠、记号棒收起；取消或失败处理与现有一致（失败保留输入、回焦）。
- 记号棒展开时占据头顶位置，气泡堆叠在其上方让位；记号棒展开本身也使窗口进入"有内容"的增高状态。
- 命中测试与鼠标穿透：记号棒输入区与按钮需 `pointer-events:auto` 并在 `renderer.ts` 的穿透判定中视为不可穿透。

## 数据流

1. 进入房间 → 房间级消息订阅建立 → 历史按发送者分组渲染到各宠物堆叠。
2. 任意成员发送文本消息 → Realtime INSERT → 按 `sender_id` 路由到对应宠物堆叠 → `addMessage`（清除该宠物 dismissed、裁剪到 20、滚到底）→ 重算窗口高度/翻转 → 刷新穿透。
3. 自己写消息 → 记号棒输入 → ✓ → `onSubmitMessage` 写库 → 自己的订阅回流 → 进入 self 堆叠。
4. 悬浮某宠物气泡区 → 关闭按钮浮现 → 点击 → 该宠物 `bubbles-dismissed` → 堆叠隐藏；若所有宠物都无可见气泡 → 窗口缩回宠物本身高度。
5. 被关闭后该宠物来新消息 → 自动重新展开。

## 边界与错误处理

- 发送失败：记号棒保留输入、显示错误、回焦（沿用现有 composer 行为）。
- 远程宠物离场时其堆叠与 DOM 一并清理（`remotePets.ts` 既有离场逻辑扩展）。
- 收到匹配不到在线宠物的消息：忽略，不报错。
- 窗口高度计算需 clamp 在屏幕可用区内，避免增高后超出屏幕底部/顶部；翻转优先于溢出。
- 多显示器：`getMonitorWorkArea()` 以宠物窗口当前所在显示器为准。

## 测试与验证

- 纯逻辑（`messageLog.ts` 容量裁剪、排序去重、栈状态、翻转标记选择）：补 Vitest 单测，沿用现有 `*.test.ts` 风格。
- 命中测试改为矩形后，更新/补充 `hitTesting` 相关断言；确认气泡、记号棒区域不可穿透，宠物外透明区可穿透。
- UI/构建：`npm run build`；`npm run dev` 检查气泡绘制、堆叠滚动、关闭浮现。
- 桌面行为：`npm run tauri dev` 验证窗口动态增高/缩回、宠物视觉位置不漂移、屏顶翻转、拖动手感、置顶与穿透、多宠物各自独立堆叠。

## 影响文件清单

- `windows/pet.html`：self 宠物 DOM 结构（堆叠 + 记号棒）。
- `src/windows/pet/messageBubble.ts`：重写为多实例栈渲染。
- `src/windows/pet/messageLog.ts`：容量裁剪、按需精简导航逻辑。
- `src/windows/pet/selfMessages.ts`：改为房间级订阅与按发送者路由（可能重命名为 `roomMessages.ts`）。
- `src/windows/pet/remotePets.ts`：远程模板含堆叠、去除「在线」占位、进出场堆叠管理。
- `src/windows/pet/renderer.ts`：命中测试改矩形、删 `cloudHitImage`、记号棒穿透、窗口高度/翻转编排。
- `src/shared/bridge.ts`：新增 `getMonitorWorkArea()`，修正 `getWindowLayout()`。
- `src/windows/pet/petLayout.ts` / `petDrag.ts`：动态窗口高度、可变锚点、位置补偿。
- `src/shared/styles.css`：代码绘制气泡、尾巴、堆叠容器、关闭按钮、记号棒样式；移除 cloud 图样式。
- `docs/database.md`：如含消息可见范围描述则同步措辞。

## 不做（YAGNI）

- 不拆分独立气泡窗口。
- 不做"用户正在翻历史时不打断"的滚动逻辑（先简单版）。
- 不做气泡自动超时淡出。
- 不做头上看全体合并对话流。
- 不引入任何前端框架/UI 库。
