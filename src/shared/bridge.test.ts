import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke, emitTo, listen, startDragging } = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn(), listen: vi.fn(), startDragging: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ listen, startDragging, label: "main" }) }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
describe("native bridge error contract", () => {
  it("returns native dragging rejection to the presenter's cleanup path", async () => {
    startDragging.mockRejectedValueOnce(new Error("drag denied"));
    const bridge = (await import("./bridge.js")).default;
    await expect(bridge.startWindowDrag()).rejects.toThrow("drag denied");
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
