# Good Puppy 开发文档

## 项目目标

Good Puppy 是一个送给朋友的桌宠应用。第一阶段先完成本地桌宠原型：从 `state_images` 文件夹选择一个小狗 GIF，在桌面透明置顶显示，并支持拖动。

后续阶段再接入远程服务器，实现远程切换形象、接收消息、显示消息气泡、通过桌宠发送消息。

## 当前阶段范围

第一步目标：

1. 使用 Electron 创建桌面窗口。
2. 窗口无边框、背景透明、始终置顶。
3. 显示 `state_images/state_01.gif`。
4. 小狗窗口可以在桌面上拖动。
5. 小狗旁边可以显示本地模拟消息气泡。

当前暂不实现：

1. 远程服务器连接。
2. 消息收发。
3. 右键菜单。
4. 打包安装程序。

## 技术选型

桌面端使用 Electron。

选择原因：

1. 对透明窗口、无边框窗口、置顶窗口支持成熟。
2. 可以直接使用 HTML/CSS 显示 GIF。
3. 后续接入 WebSocket、托盘菜单、打包发布都比较顺滑。

## 项目结构

```text
GoodPuppy/
  package.json
  docs/
    development.md
  src/
    main/
      main.js
    renderer/
      index.html
      styles.css
  state_images/
    state_01.gif
    ...
    state_24.gif
```

## 运行方式

安装依赖：

```powershell
npm.cmd install
```

本机如果已经有 Electron 缓存，也可以优先使用缓存：

```powershell
npm.cmd install --prefer-offline
```

启动应用：

```powershell
npm.cmd start
```

如果 PowerShell 提示无法运行 `npm.ps1`，使用 `npm.cmd` 即可。

## 第一阶段实现说明

Electron 主进程位于 `src/main/main.js`，负责创建桌宠窗口。

窗口关键配置：

```js
{
  width: 690,
  height: 330,
  minWidth: 690,
  minHeight: 330,
  maxWidth: 690,
  maxHeight: 330,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  resizable: false,
  skipTaskbar: true
}
```

渲染页面位于 `src/renderer/index.html`，当前直接显示：

```html
<img class="pet-image" src="../../state_images/state_01.gif" alt="Good Puppy" />
```

拖动通过渲染进程的 Pointer Events 和主进程 IPC 实现。渲染进程判断用户是在单击还是拖动，主进程负责移动 Electron 窗口。

```js
window.goodPuppy.setWindowPosition({
  x: windowStart.x + deltaX,
  y: windowStart.y + deltaY
});
```

这样点击小狗可以切换形象，按住小狗移动仍然可以拖动窗口。拖动时主进程会使用固定宽高调用 `setBounds`，避免窗口在移动过程中被意外放大或缩小。

## 已完成：本地形象切换

目标：

1. 点击小狗后，从 `state_01.gif` 到 `state_24.gif` 顺序切换。
2. 切换到 `state_24.gif` 后，再次点击回到 `state_01.gif`。
3. 按住拖动时不会误触发切换。

后续可以继续添加右键菜单和上一次选择记录。

## 已完成：消息气泡

目标：

1. 在小狗旁边显示消息气泡。
2. 支持显示几秒后自动消失。
3. 收到消息时临时切换小狗形象。

当前是本地模拟：右键点击小狗会显示一条测试消息，消息显示时小狗临时切换到 `state_03.gif`，几秒后恢复到之前状态。

气泡固定显示在桌宠左上角，使用 `img/cloud_transparent.png` 作为背景图，文字居中显示。字体使用本机系统字体栈，优先尝试圆润一点的中文字体。

气泡和小狗的鼠标交互都做了透明像素检测：只有点击图片 alpha 不透明的区域才会触发关闭气泡、切换状态、右键打开输入框或拖动窗口。窗口还会在鼠标位于非交互透明区域时启用鼠标穿透，让下层应用可以接收点击。

## 已完成：Supabase 消息读取

当前 Electron 渲染进程会通过 Supabase REST API 读取 `test` 表中的最新记录：

```text
https://mrvdeeiiwnegaqjwpsgk.supabase.co/rest/v1/test?select=id,info,state,created_at&order=created_at.desc&limit=1
```

读取到记录后：

1. 将 `info` 显示在云朵气泡中。
2. 将 `state` 作为小狗 GIF 状态编号，例如 `5` 对应 `state_05.gif`。
3. 应用启动时读取一次并记录当前最新 `id`，不主动弹出旧消息。
4. 通过 Supabase Realtime 监听 `test` 表的 `INSERT` 事件，新记录插入后立即显示新消息。
5. 新消息气泡不会自动消失，左键点击气泡后才关闭。
6. 气泡关闭后，小狗继续保持消息对应的状态。

Supabase 控制台需要将 `public.test` 加入 `supabase_realtime` publication，也可以在 SQL Editor 执行：

```sql
alter publication supabase_realtime add table public.test;
```

## 已完成：Supabase 消息发送

没有气泡显示时，右键点击小狗会在桌宠右侧打开消息输入框。

如果触控板右键不方便，也可以在小狗不透明区域长按约 0.65 秒打开消息输入框。

输入框行为：

1. 固定宽度显示在小狗右侧。
2. 输入文字变多时自动换行，并向下随内容增加高度。
3. 点击 `×` 关闭输入框。
4. 点击 `✓` 将文本插入 Supabase 的 `post` 表。

发送接口：

```text
POST https://mrvdeeiiwnegaqjwpsgk.supabase.co/rest/v1/post
```

发送内容：

```json
{
  "info": "输入的消息"
}
```

## 后续开发计划

### 第四阶段：WebSocket 通信

目标：

1. 客户端连接远程服务器。
2. 接收服务器推送的消息。
3. 接收服务器推送的小狗状态。
4. 通过桌宠向服务器发送消息。

建议消息格式：

```json
{
  "type": "message",
  "text": "今天也要开心呀",
  "state": "happy"
}
```

### 第五阶段：托盘和打包

目标：

1. 添加系统托盘。
2. 支持显示、隐藏、退出。
3. 使用 `electron-builder` 打包 Windows 安装包。

## 设计原则

1. 第一版先保持简单，避免过早引入复杂框架。
2. GIF 资源先放本地，远程服务器只发送状态名。
3. 等本地体验稳定后，再实现远程资源下载和缓存。
4. 桌宠应尽量轻巧，不打扰用户当前工作。
