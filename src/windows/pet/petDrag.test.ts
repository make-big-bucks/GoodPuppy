import { describe, expect, it } from "vitest";
import { startNativeWindowDragWithLift } from "./petDrag.js";

describe("startNativeWindowDragWithLift", () => {
  it("starts native window dragging before switching into the drag-lift animation", () => {
    const calls: string[] = [];

    startNativeWindowDragWithLift({
      isSelfPet: true,
      setNativeDragging: () => calls.push("set-native-dragging"),
      startWindowDrag: () => calls.push("start-window-drag"),
      startDragLift: () => calls.push("start-drag-lift"),
    });

    expect(calls).toEqual(["set-native-dragging", "start-window-drag", "start-drag-lift"]);
  });
});
