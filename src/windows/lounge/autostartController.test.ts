import { describe, expect, it, vi } from "vitest";
import { createAutostartController } from "./autostartController.js";
describe("device autostart ownership", () => {
  it("waits for an earlier write before a reopened view reads the state", async () => {
    let finish!: () => void; let enabled = true;
    const read = vi.fn(async () => enabled);
    const controller = createAutostartController({ read, write: async () => {
      await new Promise<void>(resolve => { finish = resolve; }); enabled = false; return enabled;
    } });
    const writing = controller.write(false); const reading = controller.read();
    await Promise.resolve(); expect(read).not.toHaveBeenCalled();
    finish(); expect(await writing).toBe(false); expect(await reading).toBe(false);
  });
  it("propagates a failed write and allows the next read to recover the actual enabled state", async () => {
    const controller = createAutostartController({ read: async () => true, write: async () => { throw new Error("permission denied"); } });
    await expect(controller.write(false)).rejects.toThrow("permission denied");
    expect(await controller.read()).toBe(true);
  });
});
