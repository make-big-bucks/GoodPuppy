import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, emitTo, listen, startDragging, setPosition } = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn(), listen: vi.fn(), startDragging: vi.fn(), setPosition: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ listen, startDragging, setPosition, label: "main" }) }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
describe("native bridge error contract", () => {
  it("reads layout bounds from one native snapshot and preserves read failures", async () => {
    const bridge = (await import("./bridge.js")).default;
    invoke.mockResolvedValueOnce({ x: -100, y: 20, width: 150, height: 120 });
    expect(await bridge.getWindowBounds()).toEqual({ x: -100, y: 20, width: 150, height: 120 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("get_window_geometry", { instanceId: bridge.getWindowInstance() });
    invoke.mockRejectedValueOnce(new Error("window unavailable"));
    await expect(bridge.getWindowPosition()).rejects.toThrow("window unavailable");
  });
  it("binds target geometry reads to the target label and instance", async () => {
    const bridge = (await import("./bridge.js")).default;
    invoke.mockResolvedValueOnce({ x: 200, y: 100, width: 180, height: 144, scaleFactor: 2 });
    expect(await bridge.getPetWindowBounds("pet-friend", "instance-a")).toMatchObject({ width: 180, scaleFactor: 2 });
    expect(invoke).toHaveBeenCalledWith("get_window_geometry", { targetLabel: "pet-friend", instanceId: "instance-a" });
  });
  it("queries the target pet monitor with its instance and propagates stale-target failure", async () => {
    const bridge = (await import("./bridge.js")).default;
    invoke.mockResolvedValueOnce({ x: 960, y: 20, width: 1280, height: 700 });
    expect(await bridge.getPetMonitorWorkArea("pet-user", "instance-a")).toMatchObject({ x: 960, width: 1280 });
    expect(invoke).toHaveBeenCalledWith("get_pet_monitor_work_area", { label: "pet-user", instanceId: "instance-a" });
    invoke.mockRejectedValueOnce(new Error("stale target"));
    await expect(bridge.getPetMonitorWorkArea("pet-user", "old")).rejects.toThrow("stale target");
  });
  it("writes Windows pet bounds with the physical desktop protocol", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      const bridge = (await import("./bridge.js")).default;
      invoke.mockResolvedValue(undefined); setPosition.mockResolvedValue(undefined);
      await bridge.setWindowBounds({ x: 2200, y: -40, width: 150, height: 120 });
      expect(invoke).toHaveBeenCalledWith("set_window_bounds", expect.objectContaining({ coordinateSpace: "desktop-physical-v2", x: 2200, width: 150 }));
      await bridge.setWindowPosition({ x: 2200, y: -40 });
      expect(setPosition).toHaveBeenCalledWith(expect.objectContaining({ type: "Physical", x: 2200, y: -40 }));
    } finally { vi.unstubAllGlobals(); }
  });
  it("returns window position write failures to the manual drag caller", async () => {
    const bridge = (await import("./bridge.js")).default;
    setPosition.mockRejectedValueOnce(new Error("position denied"));
    await expect(bridge.setWindowPosition({ x: 10, y: 20 })).rejects.toThrow("position denied");
    expect(setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 20 }));
  });
  it("returns native dragging rejection to the presenter's cleanup path", async () => {
    startDragging.mockRejectedValueOnce(new Error("drag denied"));
    const bridge = (await import("./bridge.js")).default;
    await expect(bridge.startWindowDrag()).rejects.toThrow("drag denied");
  });
  it("preserves the desktop coordinate marker for toast creation", async () => {
    const bridge = (await import("./bridge.js")).default;
    invoke.mockResolvedValue(undefined);
    await bridge.spawnToastWindow({ label: "toast-a", coordinateSpace: "desktop-physical-v2", x: 3768, y: 928, width: 340, height: 104 });
    expect(invoke).toHaveBeenCalledWith("spawn_toast_window", expect.objectContaining({ coordinateSpace: "desktop-physical-v2", x: 3768, width: 340 }));
  });
  it("does not convert spawn failures into success", async () => {
    invoke.mockRejectedValue(new Error("creation denied"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const bridge = (await import("./bridge.js")).default;
    await expect(bridge.spawnBubbleWindow({ label: "bubble-self", parentLabel: "main", isSelf: true, x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow("creation denied");
    await expect(bridge.spawnPetWindow({ label: "pet-a", x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow("creation denied");
    await expect(bridge.spawnToastWindow({ label: "toast-a", x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow("creation denied");
    log.mockRestore();
  });
  it("propagates targeted event failure to request callers", async () => {
    emitTo.mockRejectedValueOnce(new Error("send denied"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const bridge = (await import("./bridge.js")).default;
    await expect(bridge.emitToWindow("main", "request", {})).rejects.toThrow("send denied");
    log.mockRestore();
  });
});
