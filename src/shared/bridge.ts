import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import appConfig from "./appConfig.js";
import { createIgnoreMouseEventsController } from "./cursorEventsController.js";
import type { CursorPoint, GoodPuppyBridge, WindowPoint, WindowSize } from "../types";

const inTauri = "__TAURI_INTERNALS__" in window;
const appWindow = inTauri ? getCurrentWindow() : null;
const ignoreMouseEventsController = createIgnoreMouseEventsController(appWindow);

const goodPuppy: GoodPuppyBridge = {
  async getWindowPosition() {
    if (!appWindow) return { x: 0, y: 0 };
    const scale = await appWindow.scaleFactor();
    const physical = await appWindow.outerPosition();
    const logical = physical.toLogical(scale);
    return { x: logical.x, y: logical.y };
  },
  async getWindowLayout() {
    const pos = await this.getWindowPosition();
    const bounds = { x: pos.x, y: pos.y, width: 150, height: 220 };
    return { windowBounds: bounds, workArea: bounds };
  },
  setWindowPosition(position: WindowPoint) {
    if (!appWindow) return;
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
    appWindow.setPosition(new LogicalPosition(Math.round(position.x), Math.round(position.y)));
  },
  setWindowSize(size: WindowSize) {
    if (!appWindow) return;
    if (!size || typeof size.width !== "number" || typeof size.height !== "number") return;
    appWindow.setSize(new LogicalSize(Math.round(size.width), Math.round(size.height)));
  },
  supportsNativeWindowDrag() {
    return Boolean(appWindow && typeof appWindow.startDragging === "function");
  },
  startWindowDrag() {
    if (!appWindow || typeof appWindow.startDragging !== "function") return;

    appWindow.startDragging().catch((error) => {
      console.warn("Native window drag failed.", error);
    });
  },
  setIgnoreMouseEvents(shouldIgnore: boolean) {
    ignoreMouseEventsController.setIgnoreMouseEvents(shouldIgnore);
  },
  onCursorMoved(callback: (point: CursorPoint | null) => void) {
    if (!inTauri) return () => {};
    let unlisten = () => {};
    listen<CursorPoint | null>("cursor-moved", (event) => callback(event.payload)).then((fn) => {
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
