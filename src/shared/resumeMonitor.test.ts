import { afterEach, describe, expect, it, vi } from "vitest";
import { createResumeMonitor } from "./resumeMonitor.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  vi.useFakeTimers(); const win = new EventTarget(); const doc = new EventTarget();
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
  return { win, doc };
}
describe("resume detection", () => {
  it("ignores normal polling and backward clock changes, but detects a long pause", async () => {
    fixture(); let now = 0; const resume = vi.fn(async () => {});
    const dispose = createResumeMonitor(resume, () => now, 45, 15);
    now = 15; await vi.advanceTimersByTimeAsync(15); expect(resume).not.toHaveBeenCalled();
    now = -10; await vi.advanceTimersByTimeAsync(15); expect(resume).not.toHaveBeenCalled();
    now = 100; await vi.advanceTimersByTimeAsync(15); expect(resume).toHaveBeenCalledTimes(1);
    dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces online and resume notifications while recovering, and disposes listeners", async () => {
    const { win, doc } = fixture(); let now = 0; let finish!: () => void;
    const resume = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const dispose = createResumeMonitor(resume, () => now, 45, 15);
    win.dispatchEvent(new Event("online")); now = 100; doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); expect(resume).toHaveBeenCalledTimes(2);
    dispose(); finish(); await Promise.resolve();
    win.dispatchEvent(new Event("online")); expect(resume).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
