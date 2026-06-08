# GoodPuppy

A transparent, always-on-top desktop pet built with Tauri v2.

## Prerequisites

- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/tools/install)

## Run

```bash
npm install
npm run tauri dev
```

## Mac

Install prerequisites via Homebrew if needed:

```bash
brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then run:

```bash
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
