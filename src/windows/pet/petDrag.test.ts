import { describe, expect, it, vi } from "vitest";
import { startNativeWindowDragWithLift } from "./petDrag.js";

describe("startNativeWindowDragWithLift", () => {
  it("clears native dragging on asynchronous command failure", async () => {
    const dragging = vi.fn();
    await expect(startNativeWindowDragWithLift({ isSelfPet: true, setNativeDragging: dragging,
      startWindowDrag: async () => { throw new Error("denied"); }, startDragLift: () => {} })).rejects.toThrow("denied");
    expect(dragging.mock.calls).toEqual([[true], [false]]);
  });
  it("clears native dragging when starting throws synchronously", async () => {
    const dragging = vi.fn(); const lift = vi.fn();
    await expect(startNativeWindowDragWithLift({ isSelfPet: true, setNativeDragging: dragging,
      startWindowDrag: () => { throw new Error("denied"); }, startDragLift: lift })).rejects.toThrow("denied");
    expect(dragging).toHaveBeenLastCalledWith(false); expect(lift).not.toHaveBeenCalled();
  });
  it("starts native window dragging before switching into the drag-lift animation", () => {
    const calls: string[] = [];

    startNativeWindowDragWithLift({
      isSelfPet: true,
      setNativeDragging: () => calls.push("set-native-dragging"),
      startWindowDrag: () => { calls.push("start-window-drag"); },
      startDragLift: () => calls.push("start-drag-lift"),
    });

    expect(calls).toEqual(["set-native-dragging", "start-window-drag", "start-drag-lift"]);
  });
});
