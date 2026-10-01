# AGENTS.md

本文件给 Codex、Claude Code 等代码代理提供仓库级协作规则。仓库根目录的文件名建议使用 `AGENTS.md`，这是常见约定。

## 项目概览

GoodPuppy 是一个透明、置顶的桌面宠物应用：

- 前端：Vite + 原生 TypeScript/CSS，多页面入口在 `windows/*.html`，窗口代码在 `src/windows/`。
- 桌面壳：Tauri v2，Rust 代码在 `src-tauri/src/`。
- 后端服务：Supabase，数据模型说明见 `docs/database.md`。
- 当前架构与模块所有者见 `docs/architecture.md`；重要技术取舍记录在 `docs/adr/`，改动架构前先阅读相关 ADR。

## 常用命令

```bash
npm install
npm run dev
npm run test
npm run build
npm run tauri dev
npm run tauri build
```

说明：

- `npm run dev` 只启动 Vite 前端开发服务器。
- `npm run tauri dev` 启动完整桌面应用；`npm run test:native` 用独立应用标识验证窗口与退出回执。
- `npm run test` 运行 Vitest 单元测试；`npm run verify` 执行完整本地质量检查。
- `npm run build` 验证前端生产构建。
- `npm run tauri build` 产出安装包，耗时更长，只在需要验证发布构建时运行。

## 代码结构

- `windows/pet.html`：透明桌宠主窗口 DOM 结构，加载 `src/windows/pet/main.ts`。
- `windows/lounge.html`：会客厅窗口 DOM 结构，加载 `src/windows/lounge/lounge-main.ts`。
- `src/shared/bridge.ts`：Tauri API 与浏览器 fallback 的桥接层。
- `src/shared/`：跨窗口共享配置、桥接、Supabase client、基础样式和设计 token；`src/shared/pet/` 放资源、偏好、布局、头像及事件契约。
- `src/windows/pet/renderer.ts`：宠物渲染和主交互逻辑。
- `src/windows/lounge/lounge.ts`：会客厅、房间、邀请和请求相关 UI/数据逻辑。
- `src/windows/pet/petState.ts`：`PetAnimator` 分层动画状态机（瞬时层 > 状态层 > 基础层），每只 pet 一个实例。见 `docs/adr/0008-分层动画状态机与实时事件.md`。
- `src/shared/pet/animationCatalog.ts`：动画「行为事实」与形象注册表（状态分层、互动路由、`pet.json` 加载、皮肤路径解析）；资源放 `public/pets/<id>/`，皮肤变体放 `public/pets/<id>/skins/<skin>/`。
- `src/windows/pet/interactions.ts`：跨用户瞬时互动的 Realtime broadcast 总线。
- `src/windows/pet/presence.ts`：房间在线投影；认证实例租约/RPC 提供身份和状态，私有广播只提示读取快照，见 ADR-0021。
- `tools/generate-skins.mjs`：离线换肤生成器（`npm run gen:skins`），配置 `tools/skins.json`。见 `docs/adr/0010-离线调色板换肤.md`。
- `src/windows/pet/hitTesting.ts`：透明窗口命中测试逻辑。
- `src/windows/pet/petPresenter.ts`：呈现、拖动与命中形状下发；原生 `cursor.rs` / `hit_test.rs` 独占穿透切换。
- `src-tauri/src/lib.rs`：Tauri 主进程、托盘、窗口层级和原生光标采样。
- `docs/adr/`：已采纳架构决策。

## 开发原则

- 窗口目录之间不直接依赖，共享层不能反向依赖窗口；`npm run check:dependencies` 检查静态、类型、导出和动态导入，已包含在 verify/CI。
- 优先遵循现有文件风格：原生 ES modules、少量函数级拆分、无前端框架。
- 业务逻辑主要放在 webview 前端；Rust 主进程保持薄层，只承担 Tauri/系统能力。该原则来自 `docs/adr/0004-前端-webview-承担业务逻辑.md`。
- 不要引入 React、Vue、状态管理库或大型 UI 框架，除非用户明确要求并同步更新架构说明。
- 透明桌面宠物的关键体验是窗口置顶、鼠标穿透、命中区域准确；改动相关代码时必须重点验证。
- macOS 全屏 Space、窗口层级、`NSPanel` 相关逻辑非常敏感。修改 `src-tauri/src/lib.rs` 的窗口配置前，先读现有注释和 `docs/adr/0001-tauri-替代-electron.md`。
- 项目需同时支持 macOS 与 Windows。开发新功能、修 bug 时必须考虑双平台兼容，Rust 侧平台差异用 `#[cfg(target_os = ...)]` 隔离，前端避免依赖仅 macOS 可用的系统行为。
- Supabase 表结构、RLS、房间/成员关系改动必须同步更新 `docs/database.md`，必要时新增 ADR。
- 涉及数据库结构调整或数据查询时，优先通过 Supabase MCP 插件获取真实 schema 与数据状态，不要仅凭 `docs/database.md` 推断。若 MCP 插件未连接，先提示用户在开启 Supabase 集成，再继续操作。
- 涉及第三方库、框架、SDK、CLI 或云服务的 API、配置、版本迁移等问题时，优先通过 Context7 MCP 获取官方最新文档，不要仅凭训练数据作答。
- Context7 仅用于查官方文档；重构、从零写脚本、调试业务逻辑、代码评审等不依赖外部文档的任务无需调用。

## 测试与验证

改动后按影响范围选择验证：

- 前端纯逻辑：运行 `npm run test`。
- 前端 UI/构建：运行 `npm run build`，必要时启动 `npm run dev` 检查页面。
- Tauri/Rust 或桌面行为：运行 `npm run tauri dev` 手动验证窗口、托盘、置顶、鼠标穿透和会客厅。
- 发布相关改动：运行 `npm run tauri build`。

新增或修改以下模块时，优先补充相邻测试：

- `src/windows/pet/petState.ts`
- `src/windows/pet/hitTesting.ts`
- `src/windows/pet/roomManager.ts` 与 `roomCoordinator.ts`
- 任何可从 DOM/网络调用中抽离的纯逻辑

## 文档要求

- 行为、架构或数据模型变化需要更新对应文档。
- 重大技术决策新增 ADR，格式参考 `docs/adr/README.md`。
- 用户可见行为变化同步更新 `README.md`。
- 保持中文文档术语一致，避免中英文混用造成概念漂移。

## Git 与协作

- 不要回滚用户未要求回滚的改动。
- 提交前查看 `git status --short`，确认只包含本次任务相关文件。
- 保持改动范围小，避免顺手重构无关模块。
- 生成文件、构建产物和依赖目录不要提交，除非仓库已经明确追踪。

## 环境约定

- Node.js 版本：22（与 package.json、.nvmrc 和 CI 保持一致）。
- Rust：使用当前 Tauri v2 工具链。
- 后端环境按 README 配置；开发使用独立项目，禁止把 secret/service-role key 放进客户端环境变量。
- Vite 常规开发服务器端口固定为 `1420`，需与 `src-tauri/tauri.conf.json` 中的 `devUrl` 保持一致。
- 双实例开发使用 `1421`，原生隔离回归使用 `1422`，各自显式覆盖 `devUrl`。
