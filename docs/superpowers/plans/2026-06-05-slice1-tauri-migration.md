# Slice 1: Tauri 行为保真移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前 Electron 桌面 pet 的本地交互体验（透明置顶窗口、拖拽、点击穿透、托盘退出、状态切换、本地气泡输入）1:1 移植到 Tauri v2，产出一个 ~15M 的可运行 macOS 应用。

**Architecture:** Tauri v2（Rust 主进程负责窗口配置与托盘）+ Vite（vanilla JS 前端，复用现有 renderer DOM 逻辑）。Electron `main.js` 里的窗口 IPC 由前端经 `@tauri-apps/api` 直接调用窗口 API 替代，封装在一个 `window.goodPuppy` 兼容 shim（`bridge.js`）里，使现有 `renderer.js` 几乎不改即可运行。

**Scope（重要）:** Slice 1 **刻意不移植** Supabase 网络层（presence / 远程消息 / 发送）。理由：Slice 2 会基于全新 schema（rooms/auth）重写整个数据层，重新移植即将被丢弃的 `user_a_message` 逻辑是浪费。本 slice 的 composer 发送、状态切换均为**本地行为**；网络在 Slice 2 接入。渲染保持当前"两只 pet 静态显示"的视觉，多窗口/presence 驱动渲染留到 Slice 4。

**Tech Stack:** Tauri v2, Rust (cargo 1.94), Vite, vanilla JS, Vitest（单元测试）。

**Prerequisites（已确认存在，无需安装）:** Node v23, npm 10, cargo 1.94, rustc 1.94, Xcode CLT, arm64。

---

## File Structure

新增/修改文件及其职责：

- `package.json` — 改：移除 Electron 依赖与脚本，加入 Vite + Tauri 依赖与脚本。
- `vite.config.js` — 新建：Vite 配置（端口 1420，供 Tauri devUrl）。
- `index.html` — 新建（仓库根）：Vite 入口 HTML，引用 `/src/renderer/main.js`，资产路径改为 `/state_images`、`/img`。
- `src/renderer/main.js` — 新建：前端入口，按序 import `bridge.js` → `renderer.js` → `styles.css`。
- `src/renderer/bridge.js` — 新建：`window.goodPuppy` 兼容 shim，窗口控制经 `@tauri-apps/api/window` 实现，非 Tauri 环境（纯浏览器）下安全降级；网络订阅方法为 no-op。
- `src/renderer/appConfig.js` — 新建：现 `src/shared/appConfig.js` 的 ESM 版本（去掉 supabase 字段，Slice 1 不需要）。
- `src/renderer/renderer.js` — 改：资产路径；剥离 supabase 网络函数，composer/状态切换改为本地。
- `src/renderer/petState.js` — 新建：抽出纯函数 `getSafeState`（供单元测试）。
- `src/renderer/petState.test.js` — 新建：Vitest 单测。
- `public/state_images/`、`public/img/` — 由根目录 `git mv` 而来（Vite 静态资产）。
- `src-tauri/` — 新建：Rust 工程（`tauri init` 生成后按本计划配置）。
  - `src-tauri/tauri.conf.json` — pet 窗口配置（透明/无边框/置顶/固定/无阴影/skipTaskbar）+ macOSPrivateApi。
  - `src-tauri/Cargo.toml` — tauri features `macos-private-api`, `tray-icon`。
  - `src-tauri/src/lib.rs` — 托盘（退出菜单）。
  - `src-tauri/src/main.rs` — 入口。
  - `src-tauri/capabilities/default.json` — 窗口权限。
- 删除（Task 7）：`src/main/main.js`、`src/main/preload.js`、`src/shared/appConfig.js`、`scripts/build-users.js`、`scripts/build-mac-user-a.js`。

---

## Task 1: Vite 脚手架 + 前端入口 + 资产迁移

**Files:**
- Modify: `package.json`
- Create: `vite.config.js`, `index.html`, `src/renderer/main.js`, `src/renderer/bridge.js`, `src/renderer/appConfig.js`
- Move: `state_images/` → `public/state_images/`, `img/` → `public/img/`

- [ ] **Step 1: 安装 Vite 与 Tauri 前端依赖**

Run:
```bash
cd /Users/nanshine/PlayGround/GoodPuppy
npm install -D vite@^6 vitest@^2
npm install @tauri-apps/api@^2
npm install -D @tauri-apps/cli@^2
```
Expected: 安装成功，`package.json` 出现这些依赖。

- [ ] **Step 2: 更新 `package.json` 的 scripts（暂保留 electron 依赖，Task 7 再删）**

把 `"scripts"` 块替换为：
```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "test": "vitest run"
  },
```

- [ ] **Step 3: 创建 `vite.config.js`**

```js
import { defineConfig } from "vite";

// Tauri 期望前端 dev server 在固定端口（与 tauri.conf.json devUrl 一致）
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    emptyOutDir: true,
  },
});
```

- [ ] **Step 4: 迁移静态资产到 `public/`**

Run:
```bash
mkdir -p public
git mv state_images public/state_images
git mv img public/img
ls public/state_images | head -3 && ls public/img
```
Expected: `public/state_images/state_01.gif` 等存在；`public/img/` 含 `cloud_transparent.png` 与 `dog.ico`。
若 `public/img/cloud_transparent.png` 不存在，停止并报告（renderer 的气泡 hit-test 依赖它）。

- [ ] **Step 5: 创建 ESM 版 `src/renderer/appConfig.js`**

```js
// Slice 1：本地体验，不含 supabase 字段（Slice 2 重建数据层时引入）
const currentUser = "user_a";

const userConfigs = {
  user_a: { side: "left", initialState: 6 },
  user_b: { side: "right", initialState: 6 },
};

export default { currentUser, userConfigs };
```

- [ ] **Step 6: 创建 `src/renderer/bridge.js`（window.goodPuppy 兼容 shim）**

```js
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import appConfig from "./appConfig.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const appWindow = inTauri ? getCurrentWindow() : null;

const goodPuppy = {
  async getWindowPosition() {
    if (!appWindow) return { x: 0, y: 0 };
    const scale = await appWindow.scaleFactor();
    const physical = await appWindow.outerPosition();
    const logical = physical.toLogical(scale);
    return { x: logical.x, y: logical.y };
  },
  async getWindowLayout() {
    // renderer 当前未使用此方法，提供最小实现以兼容接口
    const pos = await this.getWindowPosition();
    const bounds = { x: pos.x, y: pos.y, width: 780, height: 340 };
    return { windowBounds: bounds, workArea: bounds };
  },
  setWindowPosition(position) {
    if (!appWindow) return;
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
    appWindow.setPosition(new LogicalPosition(Math.round(position.x), Math.round(position.y)));
  },
  setIgnoreMouseEvents(shouldIgnore) {
    if (!appWindow) return;
    if (typeof shouldIgnore !== "boolean") return;
    appWindow.setIgnoreCursorEvents(shouldIgnore);
  },
  getAppConfig() {
    return appConfig;
  },
  // 网络订阅：Slice 1 为 no-op，Slice 2 接入新数据层
  onRemoteMessage() {},
  onRemoteMessageStatus() {},
  onPresenceUpdate() {},
  onPresenceStatus() {},
};

window.goodPuppy = goodPuppy;
export default goodPuppy;
```

- [ ] **Step 7: 创建前端入口 `src/renderer/main.js`**

```js
// 顺序重要：bridge 必须先于 renderer 执行（renderer 顶层会读 window.goodPuppy）
import "./bridge.js";
import "./styles.css";
import "./renderer.js";
```

- [ ] **Step 8: 创建仓库根 `index.html`（Vite 入口）**

把 `src/renderer/index.html` 的内容复制到根 `index.html`，并做两处改动：
1. 两个 `<img>` 的 `src` 从 `../../state_images/state_06.gif` 改为 `/state_images/state_06.gif`。
2. 把末尾 `<script src="./renderer.js"></script>` 替换为 `<script type="module" src="/src/renderer/main.js"></script>`。
3. 删除 `<head>` 中的 `<link rel="stylesheet" href="./styles.css" />`（样式改由 main.js import）。

完整内容：
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Good Puppy</title>
  </head>
  <body>
    <main class="pet-stage is-initializing" aria-label="Good Puppy desktop pet">
      <section class="dog-area left-dog" data-user="user_a" aria-label="Left puppy">
        <div class="message-bubble left-bubble" role="status" aria-live="polite" data-user="user_a" hidden>
          <span class="message-alert" aria-hidden="true">!</span>
          <div class="bubble-content">
            <div class="bubble-text"></div>
            <div class="bubble-nav" aria-label="Message navigation">
              <button class="bubble-nav-button bubble-prev" type="button" aria-label="Previous message">&lt;</button>
              <button class="bubble-nav-button bubble-next" type="button" aria-label="Next message">&gt;</button>
              <button class="bubble-nav-button bubble-compose" type="button" aria-label="Write message">+</button>
            </div>
          </div>
          <form class="bubble-composer" hidden>
            <textarea class="bubble-input" aria-label="Message text" rows="1"></textarea>
            <div class="bubble-actions">
              <button class="bubble-button bubble-cancel" type="button" aria-label="Cancel">&times;</button>
              <button class="bubble-button bubble-send" type="submit" aria-label="Send">&#10003;</button>
            </div>
          </form>
        </div>
        <img class="pet-image left-pet" data-user="user_a" src="/state_images/state_06.gif" alt="Left puppy" draggable="false" />
      </section>

      <section class="dog-area right-dog" data-user="user_b" aria-label="Right puppy">
        <div class="message-bubble right-bubble" role="status" aria-live="polite" data-user="user_b" hidden>
          <span class="message-alert" aria-hidden="true">!</span>
          <div class="bubble-content">
            <div class="bubble-text"></div>
            <div class="bubble-nav" aria-label="Message navigation">
              <button class="bubble-nav-button bubble-prev" type="button" aria-label="Previous message">&lt;</button>
              <button class="bubble-nav-button bubble-next" type="button" aria-label="Next message">&gt;</button>
              <button class="bubble-nav-button bubble-compose" type="button" aria-label="Write message">+</button>
            </div>
          </div>
          <form class="bubble-composer" hidden>
            <textarea class="bubble-input" aria-label="Message text" rows="1"></textarea>
            <div class="bubble-actions">
              <button class="bubble-button bubble-cancel" type="button" aria-label="Cancel">&times;</button>
              <button class="bubble-button bubble-send" type="submit" aria-label="Send">&#10003;</button>
            </div>
          </form>
        </div>
        <img class="pet-image right-pet is-flipped" data-user="user_b" src="/state_images/state_06.gif" alt="Right puppy" draggable="false" />
      </section>
    </main>
    <script type="module" src="/src/renderer/main.js"></script>
  </body>
</html>
```

- [ ] **Step 9: 复制 styles.css 供 import**

`src/renderer/styles.css` 已存在且路径不变（main.js 用相对 import `./styles.css`），无需移动。确认存在：
Run: `ls src/renderer/styles.css`
Expected: 文件存在。

- [ ] **Step 10: 浏览器冒烟（renderer 尚未剥离网络，预期有 fetch 报错但页面应渲染）**

Run: `npm run dev`，浏览器打开 `http://localhost:1420`。
Expected: 看到两只小狗 gif；DOM 正常。控制台可能有 supabase fetch 失败的报错（Task 2 会清理），但**不应有** `Cannot read properties of undefined (reading 'getAppConfig')` 这类崩溃。
确认后 Ctrl-C 停止 dev server。

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(slice1): scaffold Vite frontend + Tauri bridge shim, migrate assets"
```

---

## Task 2: 剥离 Supabase 网络，composer/状态切换改为本地

**Files:**
- Modify: `src/renderer/renderer.js`

- [ ] **Step 1: 改资产路径**

把 `src/renderer/renderer.js` 第 49 行：
```js
cloudHitImage.src = "../../img/cloud_transparent.png";
```
改为：
```js
cloudHitImage.src = "/img/cloud_transparent.png";
```

把 `getStateImagePath` 函数体：
```js
function getStateImagePath(stateNumber) {
  return `../../state_images/state_${String(stateNumber).padStart(2, "0")}.gif`;
}
```
改为：
```js
function getStateImagePath(stateNumber) {
  return `/state_images/state_${String(stateNumber).padStart(2, "0")}.gif`;
}
```

- [ ] **Step 2: 删除 supabaseConfig 定义块**

删除第 24-28 行：
```js
const supabaseConfig = {
  restUrl: appConfig.supabase.restUrl,
  apiKey: appConfig.supabase.apiKey,
  sendTableName: currentUserConfig.tableName
};
```
（`appConfig.supabase` 在新 ESM config 中已不存在；这行若保留会抛错。）

- [ ] **Step 3: 删除网络函数 `getSupabaseHeaders`、`fetchLatestRemoteMessages`、`handleRemoteMessage`、`subscribeToRemoteMessages`**

删除这四个函数的完整定义（原 457-532 行区间内）。它们依赖 `supabaseConfig` 与 `window.goodPuppy.onRemoteMessage`，Slice 1 不需要。

- [ ] **Step 4: 把 `subscribeToPresence` 简化为纯本地在线状态**

将 `subscribeToPresence` 整个函数替换为：
```js
function subscribeToPresence() {
  // Slice 1：无网络。当前用户在线，其它用户离线（Slice 4 由 presence 驱动）。
  Object.keys(appConfig.userConfigs).forEach((userId) => {
    setUserOnline(userId, userId === appConfig.currentUser);
  });
}
```

- [ ] **Step 5: 把 `initializeRemoteMessages` 改为本地初始化**

将 `initializeRemoteMessages` 整个函数替换为：
```js
function initializeRemoteMessages() {
  // Slice 1：无远程消息拉取，仅收尾初始化状态
  petStage.classList.remove("is-initializing");
  refreshMousePassthrough();
}
```

- [ ] **Step 6: 把 `sendComposerMessage` 改为本地添加（不发网络）**

将 `sendComposerMessage` 整个函数替换为：
```js
async function sendComposerMessage(userId) {
  const input = getBubbleInput(userId);
  const info = input?.value.trim();

  if (!info) {
    input?.focus();
    return;
  }

  // Slice 1：本地回显（Slice 2 接入网络发送）
  addLocalMessage(
    userId,
    { id: `local-${Date.now()}`, info, state: currentState, created_at: new Date().toISOString() },
    { markUnread: false, updatePetState: true }
  );
  closeBubbleComposer(userId);
}
```

- [ ] **Step 7: 删除底部对 `subscribeToRemoteMessages()` 的调用**

把文件末尾（原 926-928 行）：
```js
subscribeToRemoteMessages();
subscribeToPresence();
initializeRemoteMessages();
```
改为：
```js
subscribeToPresence();
initializeRemoteMessages();
```

- [ ] **Step 8: 浏览器验证本地交互**

Run: `npm run dev`，打开 `http://localhost:1420`，打开控制台。
Expected（全部满足）：
- 控制台无报错（尤其无 fetch / undefined 报错）。
- 点击左侧小狗（user_a）一下 → pet 切换到下一个状态 gif。
- 长按左侧小狗 → 弹出气泡。
- 气泡里点 `+` → 出现输入框；输入文字点对勾 → 文字显示在气泡中（本地回显）。
- 气泡 `<` / `>` 导航按钮可用。
Ctrl-C 停止。

- [ ] **Step 9: Commit**

```bash
git add src/renderer/renderer.js
git commit -m "feat(slice1): strip Supabase networking, local-only composer and presence"
```

---

## Task 3: 初始化 Tauri 工程 + 配置 pet 窗口

**Files:**
- Create: `src-tauri/` (via CLI)，随后改 `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: 用 CLI 生成 src-tauri 脚手架（非交互）**

Run:
```bash
cd /Users/nanshine/PlayGround/GoodPuppy
npx @tauri-apps/cli@^2 init \
  --app-name "GoodPuppy" \
  --window-title "GoodPuppy" \
  --frontend-dist "../dist" \
  --dev-url "http://localhost:1420" \
  --before-dev-command "npm run dev" \
  --before-build-command "npm run build" \
  --ci
```
Expected: 生成 `src-tauri/`（含 `Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`, `build.rs`, `capabilities/default.json`, `icons/`）。

- [ ] **Step 2: 覆盖 `src-tauri/tauri.conf.json` 为 pet 窗口配置**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "GoodPuppy",
  "version": "0.1.0",
  "identifier": "com.goodpuppy.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "macOSPrivateApi": true,
    "withGlobalTauri": false,
    "security": { "csp": null },
    "windows": [
      {
        "label": "main",
        "title": "GoodPuppy",
        "width": 780,
        "height": 340,
        "resizable": false,
        "maximizable": false,
        "decorations": false,
        "transparent": true,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "shadow": false
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ]
  }
}
```

- [ ] **Step 3: 在 `src-tauri/Cargo.toml` 给 tauri 开启所需 features**

找到 `[dependencies]` 中的 `tauri = { version = "2", features = [...] }`，把 features 改为：
```toml
tauri = { version = "2", features = ["macos-private-api", "tray-icon", "image-png"] }
```
（`macos-private-api` 是透明窗口必需；`tray-icon`/`image-png` 供 Task 5 托盘。）

- [ ] **Step 4: 验证透明置顶 pet 窗口能起来**

Run: `npm run tauri dev`
Expected: 首次会编译 Rust（数分钟）。随后弹出一个**无边框、背景透明、置顶**的窗口，里面是两只小狗。窗口不在 Dock 任务栏占位（skipTaskbar）。
若窗口背景为白色不透明 → 检查 `macOSPrivateApi: true` 与 Cargo 的 `macos-private-api` feature 是否都已设置。
确认后关闭/Ctrl-C。

- [ ] **Step 5: Commit**

```bash
git add src-tauri package.json package-lock.json
git commit -m "feat(slice1): init Tauri v2, configure transparent frameless pet window"
```

---

## Task 4: 窗口控制权限（拖拽 + 点击穿透）

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: 给前端授予窗口控制权限**

把 `src-tauri/capabilities/default.json` 的 `"permissions"` 数组替换为：
```json
  "permissions": [
    "core:default",
    "core:window:allow-set-position",
    "core:window:allow-outer-position",
    "core:window:allow-outer-size",
    "core:window:allow-scale-factor",
    "core:window:allow-set-ignore-cursor-events"
  ]
```
（其余字段如 `identifier`、`windows: ["main"]` 保持不变。）

- [ ] **Step 2: 验证拖拽与点击穿透**

Run: `npm run tauri dev`
Expected（全部满足）：
- 在小狗身上按住拖动 → 整个窗口跟随移动。
- 鼠标移到小狗**之外**的透明区域 → 点击会穿透到下层应用（例如能点到背后的 Finder/桌面）。
- 鼠标在小狗**身上** → 可交互（单击切换状态、长按出气泡）。
若拖拽时窗口位置发生跳变/抖动 → 检查 `bridge.js` 的 `getWindowPosition` 是否用 `toLogical(scale)` 把物理坐标换算成逻辑坐标（renderer 用的是 CSS 逻辑像素 `screenX/screenY`）。
确认后 Ctrl-C。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/capabilities/default.json
git commit -m "feat(slice1): grant window position + cursor-passthrough permissions"
```

---

## Task 5: 系统托盘 + 退出

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: 在 `src-tauri/src/lib.rs` 加托盘与退出菜单**

把 `src-tauri/src/lib.rs` 内容替换为：
```rust
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&quit]).build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GoodPuppy")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: 确认 `src-tauri/src/main.rs` 调用 run()**

确认内容为（`tauri init` 生成时 crate 名通常为 `good_puppy_lib`；若 `Cargo.toml` 的 `[lib] name` 不同则相应调整）：
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    good_puppy_lib::run();
}
```
若编译报 `unresolved import good_puppy_lib` → 打开 `src-tauri/Cargo.toml` 查看 `[lib] name`，把 `main.rs` 里的 crate 名改成它。

- [ ] **Step 3: 验证托盘退出**

Run: `npm run tauri dev`
Expected: 菜单栏出现 GoodPuppy 托盘图标；点击它出现"退出"菜单项；点"退出"后应用关闭。
Ctrl-C（若已退出则无需）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat(slice1): add system tray with quit"
```

---

## Task 6: 抽出纯函数并加单元测试（TDD）

**Files:**
- Create: `src/renderer/petState.js`, `src/renderer/petState.test.js`
- Modify: `src/renderer/renderer.js`

- [ ] **Step 1: 写失败测试**

创建 `src/renderer/petState.test.js`：
```js
import { describe, it, expect } from "vitest";
import { getSafeState } from "./petState.js";

describe("getSafeState", () => {
  it("returns the state when it is a valid integer in [1,24]", () => {
    expect(getSafeState(5)).toBe(5);
    expect(getSafeState(1)).toBe(1);
    expect(getSafeState(24)).toBe(24);
  });

  it("returns the fallback for out-of-range or non-integer input", () => {
    expect(getSafeState(0)).toBe(3);
    expect(getSafeState(25)).toBe(3);
    expect(getSafeState(NaN)).toBe(3);
    expect(getSafeState(2.5)).toBe(3);
  });

  it("honors a custom fallback", () => {
    expect(getSafeState(99, 6)).toBe(6);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/renderer/petState.test.js`
Expected: FAIL —— 找不到模块 `./petState.js`。

- [ ] **Step 3: 创建 `src/renderer/petState.js`**

```js
export const stateCount = 24;

export function getSafeState(stateNumber, fallback = 3) {
  return Number.isInteger(stateNumber) && stateNumber >= 1 && stateNumber <= stateCount
    ? stateNumber
    : fallback;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/renderer/petState.test.js`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: 让 renderer.js 复用该模块（去重）**

在 `src/renderer/renderer.js` 顶部加入 import（文件首行）：
```js
import { getSafeState, stateCount } from "./petState.js";
```
然后删除 renderer.js 内原有的本地定义：
- 删除第 5 行 `const stateCount = 24;`
- 删除 `getSafeState` 函数定义（原 350-354 行）。

- [ ] **Step 6: 回归验证**

Run: `npm run dev`，浏览器打开，点击小狗确认状态仍能切换、长按出气泡正常（确认 import 改造没破坏行为）。
Run: `npx vitest run`
Expected: 页面行为正常；测试通过。
Ctrl-C。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/petState.js src/renderer/petState.test.js src/renderer/renderer.js
git commit -m "test(slice1): extract getSafeState into tested pure module"
```

---

## Task 7: 生产构建、体积验证、移除 Electron

**Files:**
- Modify: `package.json`, `.gitignore`
- Delete: `src/main/main.js`, `src/main/preload.js`, `src/shared/appConfig.js`, `scripts/build-users.js`, `scripts/build-mac-user-a.js`

- [ ] **Step 1: 生产构建**

Run: `npm run tauri build`
Expected: 构建出 `src-tauri/target/release/bundle/macos/GoodPuppy.app` 与 `src-tauri/target/release/bundle/dmg/GoodPuppy_0.1.0_aarch64.dmg`。

- [ ] **Step 2: 验证体积与可运行**

Run:
```bash
du -sh src-tauri/target/release/bundle/macos/GoodPuppy.app
du -sh src-tauri/target/release/bundle/dmg/*.dmg
open src-tauri/target/release/bundle/macos/GoodPuppy.app
```
Expected: `.app` 显著小于旧 Electron（目标 < 30M，通常 ~10-20M）；双击打开后出现透明置顶小狗，拖拽/点击穿透/托盘退出均正常。

- [ ] **Step 3: 移除 Electron 文件与依赖**

Run:
```bash
git rm src/main/main.js src/main/preload.js src/shared/appConfig.js scripts/build-users.js scripts/build-mac-user-a.js
npm uninstall electron electron-builder
```
Expected: 文件删除；`package.json` 不再含 electron / electron-builder。

- [ ] **Step 4: 清理 `package.json` 的 Electron 残留**

- 删除顶层 `"main": "src/main/main.js"` 字段（或改为不需要）。
- 删除整个 `"build": { ... }`（electron-builder 配置）块。
- 确认 `"scripts"` 为 Task 1 Step 2 设置的版本（无 `start`/`dist`/`dist:*`）。

- [ ] **Step 5: 更新 `.gitignore`**

确保包含（追加缺失项）：
```
node_modules
dist
src-tauri/target
release
```

- [ ] **Step 6: 删除旧 Electron 构建产物目录（若存在）**

Run: `git rm -r --cached release 2>/dev/null; rm -rf release`
Expected: 旧 `release/`（112M DMG 等）移出版本库。

- [ ] **Step 7: 最终回归**

Run: `npm run tauri dev`
Expected: 应用正常启动，全部本地交互（拖拽、点击穿透、状态切换、气泡、托盘退出）工作。
Ctrl-C。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore(slice1): remove Electron, finalize Tauri build (~15M)"
```

---

## 验收标准（Slice 1 Done）

- `npm run tauri dev` 启动一个透明、无边框、置顶、不占任务栏的小狗窗口。
- 拖拽小狗移动窗口；空白区域点击穿透；小狗身上可交互（单击切状态、长按出气泡、`+` 本地输入回显、`<`/`>` 导航）。
- 托盘"退出"可关闭应用。
- `npm run tauri build` 产出 `.app` < 30M。
- `npx vitest run` 通过。
- 仓库不再依赖 Electron。
- 网络（presence/远程消息/发送）按设计**未接入**，留待 Slice 2。
