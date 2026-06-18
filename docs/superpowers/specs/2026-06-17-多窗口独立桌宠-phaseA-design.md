# 多窗口独立桌宠 · Phase A 设计

- 日期：2026-06-17（2026-06-18 修订：合入「`main` 去 panel 化 / 修复 first-mouse / 自己·远程气泡 panel 分流」，对齐 ADR-0014）
- 状态：待评审（依赖 Phase B 落地）
- 前置：[Phase B 设计](2026-06-17-多窗口独立桌宠-phaseB-design.md)
- 关联：[ADR-0014：放弃全屏覆盖与动态窗口去 NSPanel 化](../../adr/0014-放弃全屏覆盖与动态窗口去-nspanel-化.md)（本期把 textarea 搬出 `main` 后，`main` 也随之去 panel 化，是 ADR-0014 方向的延续）

## 背景与目标

Phase B 已实现"一只 pet 一个独立窗口、可分别拖动"，但气泡仍留在各自 pet 窗口内，靠窗口纵向增高/翻转承接。Phase A 把气泡升级为**独立透明窗口**，由 OS 让它自动跟随 pet 窗口移动（原生父子窗口）。

这是当初用户最初设想的终态——"各桌宠的气泡变成独立窗口，伴随桌宠本身"。它也是整个多窗口方案里**唯一真正新增原生代码**的部分，故独立成期、放在多屏与动态生命周期都踩实之后。

## 收益

相比 Phase B：
- pet 窗口回到**固定 pet 尺寸**，不再为气泡增高/翻转 → 命中区/穿透上沿干净、绝不因弹气泡跳位。
- 气泡可自由浮出 pet 边界、尺寸不受 pet 窗口约束。
- **退役 Phase B 残留的最后一坨布局复杂度**：`getBubbleWindowLayout` / `computeWindowTop` / `petAnchorBottomY` / `shouldFlipStack` / CSS `--stack-below` / `is-flipped` 全删，`applyWindowLayout` 的纵向逻辑消失。这是 A 期的核心回报。
- **`main` 去 panel 化**：记号棒 textarea 搬进自己的气泡窗口后，`main` 不再需要成为 key window（提升为 `GoodPuppyPanel` 的唯一理由就是让 textarea 能接收键盘，见 ADR-0014）。撤掉 `configure_self_panel`，让 `main` 走和远程 pet 一样的普通 `configure_floating_overlay`。自己 pet 与远程 pet 的窗口配置自此完全对称。
- **顺带修复 macOS first-mouse 拖动 bug**：现状下右键弹菜单后点别的窗口、或拖过别的 pet 再回来时，第一次左键只用于激活面板、不派发到 webview，导致需点两次才能拖（场景 1）。根因是 `main` 作为非激活 `NSPanel` 的 `becomesKeyOnlyIfNeeded` 语义——普通点击故意不接管 key。`main` 去 panel 化后变回普通窗口，配合已设的 `accept_first_mouse(true)`，第一次左键即可拖动。这是本期一个具体可验收的 UX 修复点。

## 跟随机制（A 期唯一硬骨头，平台分叉）

- **macOS**：`[parentWindow addChildWindow:child ordered:NSWindowAbove]`。OS 在 pet 移动时**自动带气泡窗口同步移动**，零延迟、原生拖动期间也跟手——这正是选子窗口路线的根本理由。
- **Windows**：`set_parent` 仅建立 owner 关系，**不会随父窗口移动自动跟随**。需 Rust 监听父窗口 `WindowEvent::Moved` 重新摆放子窗口。原生拖动走 OS 模态移动循环，须先验证拖动期间 `Moved` 是否连续触发：
  - 连续 → 跟手；
  - 被节流/缺失 → 退化为拖动结束归位（短暂滞后），或 Rust 侧轮询补偿。

> **开工前置 spike**：在 Windows 上验证原生拖动期间 `WindowEvent::Moved` 的触发频率与子窗口重定位的视觉跟手程度。这是 A 期唯一不可预期项，其余均可预期。

## 气泡窗口本身

- 新建极简 `bubble.html`（气泡 only 模式），渲染 `.bubble-stack` + 记号棒，复用现有气泡渲染代码。
- 气泡窗口都需要：透明、自己的穿透/像素命中（关闭按钮、滚动、textarea），因此都由光标监视器服务。
- **panel 分流（关键，对齐 ADR-0014）**：只有**自己的**气泡窗口里有可写记号棒 textarea，需提升为 `GoodPuppyPanel`（`canBecomeKeyWindow`）；**远程**气泡窗口只显示消息、无可写输入，做成**普通透明窗口**即可。这样：
  - 自己气泡窗口跟 `main` 一样整会话只隐藏不销毁 → 不碰 ADR-0014 的「销毁被提升 panel 即崩」雷区；
  - 远程气泡窗口是普通窗口，可随成员离线安全销毁，与远程 pet 窗口同构。
- **写消息焦点**：`focus_pet_panel`（更名后语义为「聚焦自己气泡窗口」）改由自己的气泡窗口调用（它就是 textarea 宿主），逻辑不变。

## 上下/翻转

退化为：气泡窗口初始摆 pet 上方；上方空间不足摆下方；pet 移动跨阈值时重算一次。比 Phase B 的"撑高再反锚点补偿"更简单、更不易出错。

## 通信契约：Phase B 已铺好

协调者事件契约几乎不动：
- Phase B：`pet-state` 与 `pet-message` 都发给 pet 窗口。
- Phase A：仅把 `pet-message` / `pet-interaction` 改投到气泡窗口（label `bubble-<userId>`）；`pet-state` 仍投 pet 窗口。

位置体系不变：pet 窗口仍是锚点，气泡跟随。**协调者基本无感**——这是分期的价值所在。

## 代码改动面

### 前端
- 新增 `bubble.html` + 气泡 only 入口（复用 `messageBubble.ts` / `composeStick.ts`，去掉 pet 动画部分）。
- pet 窗口 renderer：移除窗口内气泡 DOM 与纵向布局；保留单 pet 动画 + 拖动 + 穿透。
- `petLayout.ts`：删除纵向气泡布局函数（`getBubbleWindowLayout` / `computeWindowTop` / `petAnchorBottomY` / `shouldFlipStack`）。
- 协调者：`pet-message` / `pet-interaction` 改投 `bubble-<userId>`；气泡上下/翻转初始位置计算。

### Rust（`src-tauri/src/lib.rs`）
- `spawn_bubble_window(parent_label, is_self, ...)`：建透明窗口 → `configure_floating_overlay`（普通浮动覆盖层，ADR-0014 后的统一入口；**不再用已删除的 `configure_macos_overlay_level`**）→ `set_parent`（macOS 即 addChildWindow，ordered above）。**仅当 `is_self` 时**追加 `configure_self_panel` 把自己气泡窗口提升为 `GoodPuppyPanel`（承载记号棒 textarea）。
- **`main` 去 panel 化**：textarea 移出后，启动流程不再对 `main` 调 `configure_self_panel`，改走 `configure_floating_overlay`；`main` 仍补 `accept_first_mouse(true)`（静态 conf 已有，确认保留）。这是修复 first-mouse 场景 1 的落点。
- macOS：addChildWindow 自动跟随；Windows：监听父窗口 `WindowEvent::Moved` → 重定位子窗口。
- 气泡窗口生命周期：**远程**气泡窗口随对应远程 pet 窗口一起销毁（普通窗口，安全）；**自己**的气泡窗口随 `main` 整会话只隐藏不销毁（panel，避开 ADR-0014 销毁崩溃）。
- 光标监视器：纳入气泡窗口（label 前缀 `bubble-`）。

## A 期独有成本

1. 跟随机制平台分叉：macOS 免费（addChildWindow），Windows 需 `Moved` 重定位 + 前置 spike。
2. 窗口数翻倍（每 pet 多一气泡窗）→ 光标监视器负载 2N。缓解：仅对**光标附近**的窗口做像素命中（监视器已知各窗口位置，可先做包围盒粗筛）。
3. 子窗口需穿透/overlay 配置；**panel 仅自己气泡窗口需要**（远程气泡为普通窗口）。

## 模块边界自检

- **气泡窗口**：输入 = 协调者 `pet-message`/`pet-interaction` + 自身穿透/命中；输出 = 气泡渲染 + 写消息请求。无网络、无 pet 动画依赖，可独立测试。
- **父子关系（Rust）**：输入 = parent_label + 几何；输出 = 子窗口创建 + 跟随。macOS/Windows 分别验证。
- **气泡上下/翻转**：抽成纯函数（pet 几何 + 屏幕可用区 → 气泡窗口位置 + above/below），可单测。

## 验证策略

- 前置 spike：Windows 拖动期间子窗口跟手验证（决定是否需轮询补偿）。
- 单测：气泡上下/翻转位置纯函数、协调者投递目标切换（pet→bubble）。
- `npm run tauri dev` 手验（双平台）：拖动时气泡跟手不脱节、全屏 Space 下气泡窗口层级正确、写消息 textarea 能聚焦输入、关闭按钮/滚动命中正确、成员离线时远程 pet + 气泡窗口一起销毁、多屏切换正常。
- **first-mouse 回归验证（macOS，场景 1）**：右键自己桌宠弹菜单 → 点别的窗口 → 回来第一次左键应能直接拖动（`main` 去 panel 化后预期修复）；同时确认记号棒 textarea 仍能正常聚焦输入、且打字不激活整个 App（自己气泡窗口的非激活 panel 语义保持）。
- 文档：更新多窗口 ADR 增补子窗口段落；同步气泡相关文档。

## 不在本期范围（YAGNI）

- 气泡窗口的复杂动效 / 跨 pet 气泡联动。
- 多于"上方/下方"的智能避让。
