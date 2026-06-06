import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import appConfig from "./appConfig.js";
import { createIgnoreMouseEventsController } from "./cursorEventsController.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const appWindow = inTauri ? getCurrentWindow() : null;
const ignoreMouseEventsController = createIgnoreMouseEventsController(appWindow);

const goodPuppy = {
  async getWindowPosition() {
    if (!appWindow) return { x: 0, y: 0 };
    const scale = await appWindow.scaleFactor();
    const physical = await appWindow.outerPosition();
    const logical = physical.toLogical(scale);
    return { x: logical.x, y: logical.y };
  },
  async getWindowLayout() {
    const pos = await this.getWindowPosition();
    const bounds = { x: pos.x, y: pos.y, width: 260, height: 360 };
    return { windowBounds: bounds, workArea: bounds };
  },
  setWindowPosition(position) {
    if (!appWindow) return;
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
    appWindow.setPosition(new LogicalPosition(Math.round(position.x), Math.round(position.y)));
  },
  setWindowSize(size) {
    if (!appWindow) return;
    if (!size || typeof size.width !== "number" || typeof size.height !== "number") return;
    appWindow.setSize(new LogicalSize(Math.round(size.width), Math.round(size.height)));
  },
  // 是否支持系统原生窗口拖拽。macOS/Win/Linux 的 Tauri 都有，缺失时才回退到手动跟随。
  supportsNativeWindowDrag() {
    return Boolean(appWindow && typeof appWindow.startDragging === "function");
  },
  // 把这次手势交给系统：系统在设备坐标里让窗口与光标锁步移动，跨屏/跨 DPI 都正确。
  // fire-and-forget：原生拖拽会接管本次鼠标会话（含 mouseup），不返回也无需等待。
  startWindowDrag() {
    if (!appWindow || typeof appWindow.startDragging !== "function") return;

    appWindow.startDragging().catch((error) => {
      console.warn("Native window drag failed.", error);
    });
  },
  setIgnoreMouseEvents(shouldIgnore) {
    ignoreMouseEventsController.setIgnoreMouseEvents(shouldIgnore);
  },
  // 原生侧的窗口 client 光标流：窗口处于鼠标穿透状态时 webview 收不到 mousemove
  // （失焦时更是完全收不到），这里由 Rust 持续推送坐标，使穿透判定不依赖焦点。
  onCursorMoved(callback) {
    if (!inTauri) return () => {};
    let unlisten = () => {};
    listen("cursor-moved", (event) => callback(event.payload)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten();
  },
  getAppConfig() {
    return appConfig;
  },
};

window.goodPuppy = goodPuppy;
export default goodPuppy;
