import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedFetch } from "./boundedFetch.js";
const waitingFetch = vi.fn((_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}));
afterEach(() => vi.useRealTimers());
describe("bounded fetch", () => {
  it("aborts a stalled request at its deadline", async () => {
    vi.useFakeTimers();
    const request = createBoundedFetch(waitingFetch as never, 100)("https://example.test");
    const failed = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100); await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a caller cancellation instead of changing it into a timeout", async () => {
    const abort = new AbortController(); const reason = new Error("session changed");
    const request = createBoundedFetch(waitingFetch as never)("https://example.test", { signal: abort.signal });
    abort.abort(reason); await expect(request).rejects.toBe(reason);
  });
  it("cleans the timeout after success", async () => {
    vi.useFakeTimers();
    const response = await createBoundedFetch(vi.fn(async () => new Response("ok")) as never)("https://example.test");
    await response.text();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the deadline active after headers if the response body stalls", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("partial")); } })));
    const response = await createBoundedFetch(fetcher as never, 100)("https://example.test");
    const failed = expect(response.text()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100); await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("also cancels a response body when its account context is replaced", async () => {
    const caller = new AbortController();
    const fetcher = vi.fn(async () => new Response(new ReadableStream()));
    const response = await createBoundedFetch(fetcher as never)("https://example.test", { signal: caller.signal });
    const failed = expect(response.text()).rejects.toThrow("account changed");
    caller.abort(new Error("account changed")); await failed;
  });

});
