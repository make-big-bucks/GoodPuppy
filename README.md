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

## Build

To produce a distributable installer:

```bash
npm run tauri build
```

Output is in `src-tauri/target/release/bundle/`.
