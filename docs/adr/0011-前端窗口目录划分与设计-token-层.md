# ADR-0011：前端窗口目录划分与设计 token 层

- **状态**：已采纳
- **日期**：2026-06-14

## 背景

项目有三个独立窗口（桌宠 `pet.html`、登录 `login.html`、会客厅 `lounge.html`），各自一个 Vite 入口 + 一个 webview 进程，本质已是多页应用（MPA）。但代码层面存在三个随规模增长会越来越疼的问题：

1. **`src/` 平铺**：17 个 JS 文件不分窗口、不分共享层平铺，看不出哪个文件属于哪个窗口、哪些可跨窗口依赖。「未来还要加窗口」时没有可复制的固定模式。
2. **样式三处割裂、无 token 层**：`styles.css`（桌宠）+ `login.html` 内联 281 行 + `lounge.html` 内联 606 行，互不共享；雅黑字体串重复 10 次、`#2f2f35` 8 次，主题色硬编码散布，改主题要跨文件手改十几处。
3. **`renderer.js` god module（1023 行）**：动画、命中、消息、Supabase、菜单、偏好混在一起。
4. **跨窗口 / 跨网络 / 前端↔Rust 的数据契约无类型**：`window.goodPuppy.*`、presence/interaction payload、Supabase 行结构全靠注释维护。

约束：不引入 React/Vue/Tailwind 等框架（见 [ADR-0004](0004-前端-webview-承担业务逻辑.md)）；不碰命中测试 / 鼠标穿透 / 窗口层级等敏感区（见 [ADR-0001](0001-tauri-替代-electron.md)、[ADR-0007](0007-单窗口-presence-渲染.md)）。

## 决策

**用目录与轻量 token 层把已存在的 MPA 边界显式化，不引框架；渐进拆纯逻辑并补测试；用 JSDoc + `types.d.ts` 给数据契约上类型。**

1. **窗口目录划分**：`src/windows/{pet,login,lounge}/` + `src/shared/`。依赖规则：`windows/*` 可依赖 `shared/`，反之不可，`windows/*` 之间也不互相 import（对应三个独立 webview 进程的物理隔离）。`cursorEventsController.js` 归 `shared/`——它被 `shared/bridge.js` 依赖，若留在 pet 会让 shared 反向依赖 window。新增窗口 = 复制一个 `windows/<x>/` + 加 Vite 入口 + 加 Tauri window 配置。

2. **设计 token 层**（`src/shared/tokens.css`）：只收敛**真正重复且取值一致**的量（桌宠字体、`#2f2f35`、登录与会客厅共用的 `#f4f4f2`）。**刻意不统一三套调色板**——登录（`#222`）、会客厅（`#1f1f1f`/`#202020`）、桌宠（雅黑+粉）是三套独立视觉语言，强行合并会改像素。各窗口 CSS `@import` tokens 后保留自己的局部 token。内联样式抽到 `windows/<x>/<x>.css`，HTML 经 `<link>` 引用（保持与原内联相同的级联顺序，零视觉变化）。

3. **渐进拆 `renderer.js`**：一次抽一块**纯逻辑**并补相邻测试——已抽出 `preferences.js`（本地偏好读写，storage 可注入）与 `messageLog.js`（消息 normalize/排序/去重/导航边界）。Supabase 消息 IO、菜单构建等 DOM/IO 重区暂不强拆。命中/穿透/层级代码**只移动、不改逻辑**。

4. **JSDoc + `types.d.ts`**：`src/types.d.ts` 定义 `GoodPuppyBridge`、`PresenceUser`、`InteractionPayload`、Supabase 行等契约；`jsconfig.json` 设 `checkJs:false`（编辑器全局补全、不强制检查，按文件加 `// @ts-check` 开启）。作为后续渐进迁 TS 的接缝，**不引入 TS 工具链**。

## 后果

正面：

- 窗口边界与共享层在目录上可见，新增窗口有固定可复制的模式；
- 改主题色 / 字体只需动 `tokens.css` 一处；HTML 从 374/728 行降到 94/123 行；
- 抽出的纯逻辑可单测（测试 51→70）；`renderer.js` 1023→986 行；
- 数据契约有了集中类型定义与编辑器补全，且零运行时成本、不影响 build/test。

负面 / 注意：

- 登录 / 会客厅窗口仍 `import shared/styles.css`（含桌宠样式），带入少量未用 CSS——为保留 `.auth-panel` 级联依赖、降低风险而保留，可作后续清理；
- token 层故意不跨窗口统一调色板，三套近黑值仍并存（有意为之，避免视觉漂移）；
- `renderer.js` 仍偏大，后续可继续抽 Supabase 消息访问层与菜单构建；
- 类型为 JSDoc/`.d.ts`，无 `tsc` 校验，仅编辑器层面生效，真正约束需后续接入 TS。
