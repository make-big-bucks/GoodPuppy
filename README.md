# GoodPuppy

A transparent, always-on-top desktop pet built with Tauri v2.

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

## 自定义桌宠资源

仓库内的 [hatch-puppy-pet](skills/hatch-puppy-pet/SKILL.md) 支持按角色配置画风、身体结构、性格和自定义闲置动作，生成 240×240 透明 GIF。流水线保留动作位移，提供深浅背景、状态切换和镜像伙伴的动态预览，视觉验收后才打包。

资源包默认输出到 `output/pets/<id>/`；接入应用还需要复制到 `public/pets/<id>/` 并注册形象，具体步骤见 [资源与接入契约](skills/hatch-puppy-pet/references/goodpuppy-pet-contract.md)。生成包不等于已安装或已切换当前角色。

技能脚本的确定性回归测试（需要 Python 3 和 Pillow）：

```bash
python3 -m unittest discover -s skills/hatch-puppy-pet/tests -v
```
