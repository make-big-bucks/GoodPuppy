import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeChannel } from "./realtimeSubscription.js";

function channel() {
  let status!: (value: string, error?: Error) => void;
  return { value: { subscribe: vi.fn((cb) => { status = cb; }) }, status: (value: string, error?: Error) => status(value, error) };
}
afterEach(() => vi.useRealTimers());
describe("realtime subscription readiness", () => {
  it("observes disconnects after initial success and waits for reconnect preparation", async () => {
    const ch = channel(); const changes = vi.fn();
    const preparation = vi.fn(async () => {});
    const ready = subscribeChannel(ch.value as never, preparation, 100, changes);
    ch.status("SUBSCRIBED"); await ready;
    expect(changes).toHaveBeenLastCalledWith(true, undefined);
    ch.status("CHANNEL_ERROR", new Error("offline"));
    expect(changes).toHaveBeenLastCalledWith(false, expect.any(Error));
    ch.status("SUBSCRIBED"); await Promise.resolve();
    expect(preparation).toHaveBeenLastCalledWith(true);
    expect(changes).toHaveBeenLastCalledWith(true, undefined);
  });
  it("ignores a late reconnect track result after a subsequent disconnect", async () => {
    const ch = channel(); const changes = vi.fn();
    let finish!: () => void;
    const prepare = vi.fn(async () => {}).mockImplementationOnce(async () => {});
    const ready = subscribeChannel(ch.value as never, prepare, 100, changes);
    ch.status("SUBSCRIBED"); await ready;
    prepare.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    ch.status("SUBSCRIBED"); ch.status("CHANNEL_ERROR");
    finish(); await Promise.resolve();
    expect(changes).toHaveBeenLastCalledWith(false, expect.any(Error));
  });
  it("never revives an initially timed out subscription from a late callback", async () => {
    vi.useFakeTimers(); const ch = channel(); const changes = vi.fn();
    const result = expect(subscribeChannel(ch.value as never, undefined, 100, changes)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100); await result;
    ch.status("SUBSCRIBED"); await Promise.resolve();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith(false, expect.any(Error));
  });
  it("waits for subscribed and track before declaring ready, and tracks on reconnect", async () => {
    const ch = channel();
    let finish!: () => void;
    const track = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    let ready = false;
    const promise = subscribeChannel(ch.value as never, track).then(() => { ready = true; });
    expect(ready).toBe(false);
    ch.status("SUBSCRIBED");
    expect(ready).toBe(false);
    finish();
    await promise;
    expect(ready).toBe(true);
    ch.status("SUBSCRIBED");
    expect(track).toHaveBeenCalledTimes(2);
    finish();
  });
  it("rejects channel and track failures", async () => {
    const ch = channel();
    const promise = subscribeChannel(ch.value as never);
    ch.status("CHANNEL_ERROR", new Error("denied"));
    await expect(promise).rejects.toThrow("denied");
    const other = channel();
    const tracking = subscribeChannel(other.value as never, async () => { throw new Error("track failed"); });
    other.status("SUBSCRIBED");
    await expect(tracking).rejects.toThrow("track failed");
  });
  it("rejects a subscription that never becomes ready", async () => {
    vi.useFakeTimers();
    const ch = channel();
    const result = expect(subscribeChannel(ch.value as never, undefined, 100)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });
});
