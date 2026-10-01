import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationScheduler } from "./notificationScheduler.js";
function fixture(options = {}) {
  const create = vi.fn(async (_label: string, _instance: string, _slot: number, _payload: string, _signal: AbortSignal) => {});
  const close = vi.fn(async () => {}); const deliver = vi.fn(async () => {}); const valid = vi.fn(() => true);
  return { create, close, deliver, valid, scheduler: createNotificationScheduler({ key: (value: string) => value, create, close, deliver, valid, maxVisible: 1, ...options }) };
}
afterEach(() => vi.useRealTimers());
describe("notification resource ownership", () => {
  it("closes a late cancelled creation without releasing a new occupant", async () => {
    const f = fixture(); let finish!: () => void;
    f.create.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    f.scheduler.enqueue("old"); const old = f.create.mock.calls[0];
    f.scheduler.clear(); f.scheduler.enqueue("new");
    expect(old[4].aborted).toBe(true);
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(f.close).toHaveBeenCalledWith(old[0], old[1]);
    expect(f.scheduler.visibleCount).toBe(1); f.scheduler.clear();
  });
  it("bounds and deduplicates queued notifications, and discards expired work", async () => {
    vi.useFakeTimers(); const f = fixture({ maxQueued: 2, queueTtlMs: 100, readyTimeoutMs: 1000 });
    f.scheduler.enqueue("active"); const active = f.create.mock.calls[0];
    for (const value of ["a", "b", "c", "c"]) f.scheduler.enqueue(value);
    expect(f.scheduler.queuedCount).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    f.scheduler.dismiss(active[0], active[1]);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.scheduler.queuedCount).toBe(0);
  });
  it("accepts readiness only from its instance and recovers a failed spawn slot", async () => {
    const f = fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.create.mockRejectedValueOnce(new Error("spawn failed"));
    f.scheduler.enqueue("first"); f.scheduler.enqueue("second");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const current = f.create.mock.calls.at(-1)!;
    await f.scheduler.ready(current[0], "wrong-instance"); expect(f.deliver).not.toHaveBeenCalled();
    await f.scheduler.ready(current[0], current[1]); expect(f.deliver).toHaveBeenCalledWith(current[0], current[1], "second");
    f.scheduler.clear(); log.mockRestore();
  });
});
