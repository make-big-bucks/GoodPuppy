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
