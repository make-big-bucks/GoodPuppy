import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTask } from "./retryTask.js";
afterEach(() => vi.useRealTimers());
describe("cancellable recovery retry", () => {
  it("delays retries and returns the first successful snapshot", async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const errors = vi.fn();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("snapshot");
    const result = retryTask(load, abort.signal, errors, 100);
    await vi.advanceTimersByTimeAsync(99); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toBe("snapshot");
    expect(errors).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels an idle retry without issuing another request", async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const load = vi.fn().mockRejectedValue(new Error("offline"));
    const result = retryTask(load, abort.signal, () => {}, 100);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await rejection;
    expect(vi.getTimerCount()).toBe(0); expect(load).toHaveBeenCalledTimes(1);
  });
  it("rejects a late successful query after cancellation", async () => {
    const abort = new AbortController(); let finish!: (value: string) => void;
    const result = retryTask(() => new Promise<string>((resolve) => { finish = resolve; }), abort.signal, () => {});
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); finish("stale"); await rejection;
  });
});
