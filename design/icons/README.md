# GoodPuppy 桌面图标

视觉延续 `public/img/dog.ico` 的粉色爪印，采用可缩放矢量重绘，避免放大旧版 256px 位图。`app.svg` 为浅粉圆角底应用图标；`tray-template.svg` 为 macOS 单色 alpha 模板；`tray-windows.svg` 为粉色、白边、透明背景托盘图标。

运行 `npm run gen:icons` 重建 SVG 与桌面 PNG、ICO、ICNS。形状与颜色的生成源为 `tools/generate-icons.mjs`，修改视觉应先编辑该脚本；脚本通过已安装的 Tauri CLI 生成资源，仅保留桌面输出，不需要 Python 或全局 CLI。

应用打包配置分别位于 `src-tauri/tauri.conf.json` 和 `src-tauri/tauri.windows.conf.json`；托盘资源通过 Rust `include_bytes!` 内嵌，不依赖运行时外部文件路径。macOS 使用 44px 模板并启用 `icon_as_template`；其他平台使用 64px 彩色托盘图标，由系统缩放。

ICO 包含 16/24/32/48/64/256px，ICNS 包含普通与高密度图层（最高 1024px）。额外托盘 PNG 提供 macOS 22/44px 和 Windows 16/20/24/32/40/48/64px；小尺寸资源可供后续精细化选择，目前不会随 DPI 动态切换文件。Windows Store PNG 只是备用标志，未配置商店分发。

参考：[Tauri 应用图标](https://v2.tauri.app/develop/icons/)、[系统托盘](https://v2.tauri.app/learn/system-tray/)。这些资源用于传统 ICNS/ICO 图标流程，不包含 Apple Icon Composer 的分层 Liquid Glass 图标。
