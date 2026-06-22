# ADR-0014：放弃全屏 Space 覆盖，动态 pet 窗口去 NSPanel 化

- 状态：已采纳
- 日期：2026-06-18
- 修订：[ADR-0013：多窗口独立桌宠与协调者 / 呈现者模型](0013-多窗口独立桌宠与协调者模型.md)（其「每个远程成员 = 动态 `NSPanel` 窗口」一条被本 ADR 调整）
- 关联：[ADR-0001：Tauri 替代 Electron](0001-tauri-替代-electron.md)

## 背景

ADR-0013 落地多窗口后，每个在线远程成员都被动态创建成一个透明窗口，并和 `main` 一样调用 `configure_macos_overlay_level` 提升为自定义 `NSPanel`（`GoodPuppyPanel`，isa 类交换）+ 全 Space / `FullScreenAuxiliary` collection behavior，以便「悬浮在所有 Space、包括全屏应用之上」。

这套机制在单窗口时代一直只作用于 `main`，而 `main` **整个会话只隐藏、从不销毁**。多窗口拆分后第一次出现「销毁一个被提升过的、全 Space 的 `NSPanel`」：退房间时协调者 `close_pet_window` → `destroy()`。AppKit 拆除这种面板（把它从每个 Space 摘除、辞去 key/输入法上下文、结束原生拖动 tracking）会在**后续 runloop tick** 抛出 Objective-C 异常，穿过 Rust 栈触发 `fatal runtime error: Rust cannot catch foreign exceptions, aborting`，进程必崩。伴随日志 `error messaging the mach port for IMKCFRunLoopWakeUpReliable` 与 `Window move completed without beginning`。

定位过程确认：崩溃 = 「销毁」 × 「被提升的全屏 NSPanel」。两个因子去掉任一即可消除。把异常在 FFI 边界 catch、销毁前 orderOut + 清 collection behavior 等兜底都无法根治（抛出点是延迟的、不在可包裹的调用内）。

## 决策

**放弃「悬浮在全屏 Space 之上」这一产品能力，换取删除最脆弱的原生子系统、并让动态窗口走标准销毁路径。** 把窗口配置一分为二：

- **`configure_floating_overlay`（普通浮动窗口）**：只设较高窗口层级（`NSPopUpMenuWindowLevel` 101）、`hidesOnDeactivate(false)`、`canHide(false)`、无 Space 动画。**不做 isa 类交换、不是 NSPanel、不加全 Space / 全屏行为。** 所有动态生成的远程 pet 窗口（`pet-<userId>`）用它 → 它们是普通 Tauri 窗口 → 销毁是成熟路径，不再崩。
- **`configure_self_panel`（仅 `main`）**：保留 `GoodPuppyPanel` 非激活面板提升，**仅为让记号棒 textarea 能成为 key 接收键盘输入**（无边框窗口默认 `canBecomeKeyWindow` 为 NO），但去掉全 Space / 全屏 collection behavior。`main` 整会话只隐藏不销毁，故永远碰不到该崩溃。

删除随之失效的 `macos_overlay_collection_behavior` 及其测试。

## 影响

- **行为变化（用户可见）**：pet 不再出现在全屏应用之上；且因不再 `CanJoinAllSpaces`，pet 绑定在它被显示的那个普通桌面 Space 上，切到其它普通 Space 可能看不到它。定位为「不打扰全屏的桌面桌宠」。
- **可维护性提升**：删掉了 `object_setClass` 运行时改类、全 Space collection behavior 等最平台敏感、最易崩的代码；动态窗口的生命周期回归 Tauri 标准。
- `main` 的打字 / 非激活 key 行为不变（仍由面板提供）。
- `guard_appkit`（objc2 `exception` feature）保留在销毁 / `set_frame` / 光标读取处，作为窗口拆除竞态的廉价兜底与诊断。

## 备选与权衡

- **保留全屏覆盖，改为「隐藏 + 复用窗口池、永不销毁」**：能同时保住多窗口与全屏覆盖，但保留脆弱的 NSPanel 机制并新增窗口池生命周期复杂度。若日后全屏覆盖成为硬需求，这是首选回退路径。
- **退回单窗口（ADR-0007）**：无崩溃但放弃独立拖动这一核心诉求，排除。
- **跨普通 Space 跟随但不穿透全屏**：可给浮动窗口单独加回 `MoveToActiveSpace` 一类行为，作为后续中间档，但需单独验证不会把崩溃带回来。
