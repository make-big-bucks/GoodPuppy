import { describe, expect, it, vi } from "vitest";
import { createRoomTransitions } from "./roomTransitions.js";
function fixture() {
  const deps = { changed: vi.fn(), succeeded: vi.fn(), failed: vi.fn() };
  return { ...deps, controller: createRoomTransitions(deps) };
}
describe("room transition ownership", () => {
  it("prevents duplicate commands and releases pending state after failure", async () => {
    const f = fixture(); let fail!: (error: unknown) => void;
    const first = f.controller.run({ roomId: "a", type: "enter" }, () => new Promise((_, reject) => { fail = reject; }));
    const duplicate = vi.fn(async () => {});
    await f.controller.run({ roomId: "b", type: "enter" }, duplicate);
    expect(duplicate).not.toHaveBeenCalled(); expect(f.controller.pending?.roomId).toBe("a");
    fail(new Error("entry failed")); await first;
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.controller.pending).toBeNull();
    await f.controller.run({ roomId: "b", type: "enter" }, duplicate);
    expect(f.succeeded).toHaveBeenCalledWith({ roomId: "b", type: "enter" });
  });
  it("invalidates old commands without allowing their completion to clear a new command", async () => {
    const f = fixture(); let finish!: () => void; let finishNew!: () => void;
    const old = f.controller.run({ roomId: "a", type: "enter" }, () => new Promise(resolve => { finish = resolve; }));
    f.controller.invalidate();
    const next = f.controller.run({ roomId: "b", type: "exit" }, () => new Promise(resolve => { finishNew = resolve; }));
    finish(); await old;
    expect(f.succeeded).not.toHaveBeenCalled(); expect(f.controller.pending?.roomId).toBe("b");
    finishNew(); await next;
    expect(f.succeeded).toHaveBeenCalledWith({ roomId: "b", type: "exit" }); expect(f.controller.pending).toBeNull();
  });
});
