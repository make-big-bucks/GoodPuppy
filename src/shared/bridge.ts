import { createEventSubscription } from "./eventSubscription.js";
import { monitorRect, workAreaAtPoint } from "./monitorGeometry.js";
import { recordLifecycle } from "./diagnostics.js";
import {
  getCurrentWindow,
  currentMonitor,
  primaryMonitor,
  availableMonitors,
  monitorFromPoint,
  cursorPosition,
  type Monitor,
} from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import appConfig from "./appConfig.js";
import type { GoodPuppyBridge, PetHitShape, WindowPoint, WindowSize } from "../types";

const inTauri = "__TAURI_INTERNALS__" in window;
const appWindow = inTauri ? getCurrentWindow() : null;
const windowInstance = (window as Window & { __GOODPUPPY_INSTANCE__?: string }).__GOODPUPPY_INSTANCE__ ?? crypto.randomUUID();

function windowCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const tracked = /^(spawn_|close_).+_window$/.test(command) || command === "set_self_visible";
  const started = performance.now();
  const fields = {
    operation: "native-window" as const,
    action: command === "set_self_visible" ? (args.visible ? "show" as const : "hide" as const)
      : command.startsWith("spawn_") ? "spawn" as const : "close" as const,
    targetWindow: typeof args.label === "string" ? args.label : "main",
    instanceId: typeof args.instanceId === "string" ? args.instanceId : windowInstance,
  };
  if (tracked) recordLifecycle({ ...fields, phase: "start" });
  const result = invoke<T>(command, args);
  if (tracked) void result.then(() => recordLifecycle({ ...fields, phase: "ok", durationMs: Math.round(performance.now() - started) }),
    () => recordLifecycle({ ...fields, phase: "failed", durationMs: Math.round(performance.now() - started) }));
  // 日志观察者不改变原 Promise；await 调用者仍收到失败，不能误设 ready 标记。
  void result.catch((error) => console.error(`${command} failed:`, error));
  return result;
}

const goodPuppy: GoodPuppyBridge = {
  recordDiagnostic(event) { return inTauri ? invoke<void>("record_diagnostic", { event }) : Promise.resolve(); },
  getDiagnosticReport() { return inTauri ? invoke<string>("get_diagnostic_report") : Promise.resolve(""); },
  async getWindowPosition() {
    if (!appWindow) return { x: 0, y: 0 };
    const scale = await appWindow.scaleFactor();
    const physical = await appWindow.outerPosition();
    const logical = physical.toLogical(scale);
    return { x: logical.x, y: logical.y };
  },
  async getWindowSize() {
    if (!appWindow) return { width: 150, height: 120 };
    const scale = await appWindow.scaleFactor();
    const physical = await appWindow.outerSize();
    const logical = physical.toLogical(scale);
    return { width: logical.width, height: logical.height };
  },
  async getMonitorWorkArea(point) {
    // 浏览器 fallback：用 screen 的可用区域（无法精确到 taskbar/dock 时退化为整屏）。
    if (!appWindow) {
      return {
        x: 0,
        y: 0,
        width: window.screen.availWidth,
        height: window.screen.availHeight,
      };
    }
    if (point) {
      const area = workAreaAtPoint(await availableMonitors(), point);
      if (area) return area;
    }
    const monitor = await currentMonitor();
    if (!monitor) {
      return { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight };
    }
    return monitorRect(monitor, true);
  },
  async getCursorMonitorWorkArea() {
    // 上线提醒 toast 的目标屏：取光标当前所在屏的「可用区」（扣除菜单栏/dock/taskbar），
    // 回退到当前窗口所在屏 / 主屏。workArea 为物理像素，换算成逻辑像素以与窗口坐标一致。
    const fallback = {
      x: 0,
      y: 0,
      width: window.screen.availWidth,
      height: window.screen.availHeight,
    };
    if (!appWindow) return fallback;
    const toWorkArea = (monitor: Monitor | null) => {
      if (!monitor) return null;
      return monitorRect(monitor, true);
    };
    try {
      const cursor = await cursorPosition();
      const underCursor = toWorkArea(await monitorFromPoint(cursor.x, cursor.y));
      if (underCursor) return underCursor;
    } catch (error) {
      console.warn("cursor monitor lookup failed, falling back:", error);
    }
    return toWorkArea(await currentMonitor()) || toWorkArea(await primaryMonitor()) || fallback;
  },
  async getMonitors() {
    // 浏览器 fallback：只知道单块屏，用其可用区近似。
    if (!appWindow) {
      return [{ x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight }];
    }
    const monitors = await availableMonitors();
    // Monitor.size / position 为物理像素；转成逻辑像素以与窗口坐标一致。
    return monitors.map((monitor) => monitorRect(monitor));
  },
  setSelfVisible(visible: boolean) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("set_self_visible", { visible });
  },
  setWindowPosition(position: WindowPoint) {
    if (!appWindow) return;
    if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
    appWindow.setPosition(new LogicalPosition(Math.round(position.x), Math.round(position.y)));
  },
  setWindowSize(size: WindowSize) {
    if (!appWindow) return Promise.resolve();
    if (!size || typeof size.width !== "number" || typeof size.height !== "number") return Promise.resolve();
    return appWindow.setSize(new LogicalSize(Math.round(size.width), Math.round(size.height)));
  },
  setWindowBounds(bounds: WindowPoint & WindowSize) {
    if (!appWindow) return Promise.resolve();
    if (
      !bounds ||
      typeof bounds.x !== "number" ||
      typeof bounds.y !== "number" ||
      typeof bounds.width !== "number" ||
      typeof bounds.height !== "number"
    )
      return Promise.resolve();
    // 原子化 resize + reposition（单次 IPC，避免增高/翻转时窗口闪烁跳动）。
    return windowCommand<void>("set_window_bounds", {
      instanceId: windowInstance,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  },
  setFocus(reason = "?") {
    // 让置顶面板成为 key window，使记号棒的 textarea 能接收键盘输入。
    // 走原生 makeKeyAndOrderFront：面板是 NonactivatingPanel，取得 key 状态但不激活
    // 整个 App。返回是否真的成为 key window（诊断用）。
    if (!appWindow) return Promise.resolve(false);
    return invoke<boolean>("focus_pet_panel", { instanceId: windowInstance })
      .then((isKey) => {
        console.log(`[compose] focus_pet_panel(${reason}) → isKey:`, isKey);
        return isKey;
      })
      .catch((error) => {
        console.warn("focus_pet_panel failed:", error);
        return false;
      });
  },
  supportsNativeWindowDrag() {
    return Boolean(appWindow && typeof appWindow.startDragging === "function");
  },
  startWindowDrag() {
    if (!appWindow || typeof appWindow.startDragging !== "function") return Promise.resolve();
    return appWindow.startDragging();
  },
  publishHitShape(shape: PetHitShape) {
    if (!inTauri) return Promise.resolve();
    return invoke<void>("set_pet_hit_shape", { shape, instanceId: windowInstance });
  },
  getWindowInstance() { return windowInstance; },
  getManagedWindowInstance(label: string) {
    if (!inTauri) return Promise.resolve(null);
    return windowCommand<string | null>("get_managed_window_instance", { label });
  },
  getWindowLabel() {
    return appWindow?.label ?? "main";
  },
  spawnPetWindow(opts: { instanceId?: string; label: string; x: number; y: number; width: number; height: number }) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("spawn_pet_window", {
      label: opts.label,
      instanceId: opts.instanceId,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      width: Math.round(opts.width),
      height: Math.round(opts.height),
    });
  },
  closePetWindow(label: string, instanceId?: string) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("close_pet_window", { label, instanceId });
  },
  spawnBubbleWindow(opts: {
    instanceId?: string;
    label: string;
    parentLabel: string;
    isSelf: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  }) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("spawn_bubble_window", {
      label: opts.label,
      instanceId: opts.instanceId,
      parentLabel: opts.parentLabel,
      isSelf: opts.isSelf,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      width: Math.round(opts.width),
      height: Math.round(opts.height),
    });
  },
  closeBubbleWindow(label: string, instanceId?: string) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("close_bubble_window", { label, instanceId });
  },
  spawnToastWindow(opts: { instanceId?: string; label: string; x: number; y: number; width: number; height: number }) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("spawn_toast_window", {
      label: opts.label,
      instanceId: opts.instanceId,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      width: Math.round(opts.width),
      height: Math.round(opts.height),
    });
  },
  closeToastWindow(label: string, instanceId?: string) {
    if (!inTauri) return Promise.resolve();
    return windowCommand<void>("close_toast_window", { label, instanceId });
  },
  emitToWindow(label: string, event: string, payload?: unknown) {
    if (!inTauri) return Promise.resolve();
    const result = emitTo(label, event, payload);
    void result.catch((error) => console.error(`emitTo(${label}, ${event}) failed:`, error));
    return result;
  },
  // 监听当前窗口作用域的事件（而非全局 listen）：协调者用 emitTo(label, …) 定向投递，
  // 全局 listen 不按目标窗口过滤，会让同代码的多个窗口（尤其两个气泡窗口）互相收到对方
  // 的事件（placement / 消息 / 记号棒串扰）。appWindow.listen 只收发给本窗口的定向事件，
  // 广播 emit 仍能收到。见官方 multiwindow 示例。
  onAppEvent<T = unknown>(event: string, callback: (payload: T) => void) {
    return createEventSubscription<T>(async (handler) => {
      if (!appWindow) return () => {};
      return appWindow.listen<T>(event, (e) => handler(e.payload));
    }, callback);
  },
  onDragEnded(callback: () => void) {
    return this.onAppEvent("pet-drag-ended", callback);
  },
  async isAutostartEnabled() {
    if (!inTauri) return false;
    try {
      const { isEnabled } = await import("@tauri-apps/plugin-autostart");
      return await isEnabled();
    } catch (error) {
      console.error("autostart isEnabled failed:", error);
      return false;
    }
  },
  async setAutostart(enabled: boolean) {
    if (!inTauri) return false;
    try {
      const { enable, disable, isEnabled } = await import("@tauri-apps/plugin-autostart");
      if (enabled) await enable();
      else await disable();
      return await isEnabled();
    } catch (error) {
      console.error("autostart set failed:", error);
      return false;
    }
  },
  getAppConfig() {
    return appConfig;
  },
};

window.goodPuppy = goodPuppy;
export default goodPuppy;
