# GoodPuppy

A transparent, always-on-top desktop pet built with Tauri v2.

正常托盘和系统退出共用三秒清理握手，标记离线并保留所在房间，启动时自动恢复；主动退出房间或注销会清除记录。如果没有可恢复的房间，桌面宠物和自己的气泡窗口保持隐藏，进入房间后才显示，退出房间后收起，强制终止时依靠在线租约过期。

开发入口见 [当前架构](docs/architecture.md)，技术演进见 [ADR 索引](docs/adr/README.md)。

## Prerequisites

- [Node.js](https://nodejs.org/) (v22; the project includes `.nvmrc` / `.node-version`)
- [Rust](https://www.rust-lang.org/tools/install)

## Run

```bash
nvm use
npm install
npm run tauri dev
```

If your shell does not switch Node.js automatically when entering the project, run
`nvm use` once before `npm install`, `npm run dev`, or `npm run tauri dev`.

## Mac

Install prerequisites via Homebrew if needed:

```bash
brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then run:

```bash
nvm use
npm install
npm run tauri dev
```

## Windows

Install prerequisites:

1. [Node.js](https://nodejs.org/) — download and run the installer
2. [Rust](https://www.rust-lang.org/tools/install) — download and run `rustup-init.exe`
3. [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) — usually pre-installed on Windows 10/11

Then in PowerShell or Command Prompt:

```bash
npm install
npm run tauri dev
```

## 开发：双账号同时登录测试

在两个终端分别运行，可同时登录不同账号：

```bash
# 终端 1（账号 A，端口 1420）
npm run tauri dev

# 终端 2（账号 B，端口 1421）
npm run tauri:dev:peer
```

两个实例拥有独立的数据目录，Supabase session 互不干扰，适合测试连接、房间邀请等双向交互功能。

## Build

To produce a distributable installer:

```bash
npm run tauri build
```

Output is in `src-tauri/target/release/bundle/`.

## 诊断

设置页“复制诊断”按需复制本机窗口、房间与退出记录，带请求 ID、实例、会话版本和结果，不记录口令、密钥或消息正文。日志按体积轮转：单文件 256 KiB、最多三份归档；复制上限为 1 MiB。记录保存在系统应用日志目录，不自动上传，复制后由用户决定是否分享。

## 后端环境

未配置时使用已发布的生产项目并保留已有登录态。开发时复制 `.env.example` 为 `.env.development.local`，填写独立开发项目的 URL 与 publishable key，再启动 Vite；环境可选 `production`、`development`、`test`，覆盖 URL/key 必须完整且显式指定环境。开发/测试不能指向内置生产项目，各环境使用独立登录存储；生产构建默认不读取 `.env.development.local`。`VITE_` 值会进入客户端，不能放 secret/service-role key，配置错误会在打包前失败。

原生回归独占端口 `1422`，使用测试后端与独立应用标识；端口已占用会拒绝启动，不复用现有开发服务，不需要本地数据库运行。

## 自定义桌宠资源

仓库内的 [hatch-puppy-pet](skills/hatch-puppy-pet/SKILL.md) 支持按角色配置画风、身体结构、性格和自定义闲置动作，生成 240×240 透明 GIF。流水线保留动作位移，提供深浅背景、状态切换和镜像伙伴的动态预览，视觉验收后才打包。

资源包默认输出到 `output/pets/<id>/`；接入应用还需要复制到 `public/pets/<id>/` 并注册形象，具体步骤见 [资源与接入契约](skills/hatch-puppy-pet/references/goodpuppy-pet-contract.md)。生成包不等于已安装或已切换当前角色。

技能脚本的确定性回归测试（需要 Python 3 和 Pillow）：

```bash
python3 -m unittest discover -s skills/hatch-puppy-pet/tests -v
```

## 原生窗口回归检查

`npm run test:native` 使用独立应用标识验证创建、显隐、销毁、同名重建与退出清理回执，自动准备 Vite 并回收自己启动的服务器，不使用已保存账号。仅开发构建提供该检查；Windows 需在 Windows 上执行。

## 完整验证

安装 `skills/hatch-puppy-pet/requirements-test.txt` 中的 Python 测试依赖后，运行 `npm run verify`，覆盖依赖方向门禁、类型检查、生产构建、前端/Rust 和资产流水线测试。原生窗口与隔离数据库分别运行 `test:native`、`test:db`；CI 在 macOS/Windows 和 PostgreSQL 17 中执行对应检查。安装包按平台使用 `build:mac` 或 `build:windows`，生产数据库迁移单独审查与应用。

macOS 上可补 Windows Rust 交叉检查：安装相应 Rust 目标并将 `llvm-rc` 所在目录加入 PATH，运行 `cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets --locked`；这不替代 Windows 实际链接、运行和窗口验收。

会客厅侧栏拖动在失焦或隐藏时自动结束；弹层支持 Escape 关闭与 Tab 焦点切换，登录、注册、领养、注销和绑定共用在途保护，关闭弹层也不会启动并发账号操作。聊天记录按时间与 ID 分页，长期阅读采用有界窗口；阅读旧页时新消息先提示，点击“新消息”返回最新记录。Windows 旧位置记录会回退自动摆位并重新记忆，macOS 保留旧逻辑位置。上线提醒按光标所在屏幕的可用区域定位，只保留有限且未过期的队列，注销会取消在途提醒。

角色资源由 `public/pets/<id>/pet.json` 自动注册，构建与资源验收共用 `tools/petRegistry.mjs`（`default` 为保留别名），构建检查状态与皮肤文件；自己的皮肤来自账号资料，换肤在保存成功后应用，失败保留选择供重试；大小、摆放模式和位置属于本机偏好，气泡关闭状态按账号/房间/发送者隔离。

长时间暂停或网络恢复后会重新确认成员资格与房间连接，临时失败保留房间并重试。在线身份和状态来自认证实例租约快照，实时广播只触发刷新；不同实例独立续租和退出。断线时暂停互动并移除失效的在线成员，重连恢复成员资料、补查最近消息（失败后自动重试，退出即取消），全部房间频道就绪后才恢复在线标记，聊天记录显示连接中断提示。宠物隐藏时暂停闲置动画与命中掩模刷新，恢复时保留持续状态。气泡按目标宠物所在屏幕的可用区域摆放，避开菜单栏、Dock 和任务栏；屏幕空间不足时限制气泡越界。
