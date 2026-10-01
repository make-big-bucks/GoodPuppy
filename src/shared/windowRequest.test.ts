import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventSubscription } from "./eventSubscription.js";
import { requestWindow, type RequestTransport, type WindowResponse } from "./windowRequest.js";

function fixture() {
  let receive!: (value: WindowResponse) => void;
  const unlisten = vi.fn();
  let install!: () => void;
  const registered = new Promise<() => void>((resolve) => { install = () => resolve(unlisten); });
  const send = vi.fn(async (_target: string, _event: string, _payload: unknown) => {});
  const transport: RequestTransport = {
    listen: (_event, handler) => createEventSubscription(async (callback) => { receive = callback; return registered; }, handler),
    send,
  };
  const start = (overrides = {}) => requestWindow(transport, {
    target: "main", requestEvent: "request", responseEvent: "reply", payload: { roomId: "a" },
    timeoutMs: 100, cancelEvent: "cancel", ...overrides,
  });
  return { start, install, send, receive: (response: WindowResponse) => receive(response), unlisten };
}
afterEach(() => vi.useRealTimers());
describe("window request lifecycle", () => {
  it("installs the listener before sending and ignores other request IDs", async () => {
    const f = fixture();
    const result = f.start();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
    f.install();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    const request = f.send.mock.calls[0][2] as WindowResponse;
    f.receive({ requestId: "different", ok: true });
    expect(f.unlisten).not.toHaveBeenCalled();
    f.receive({ requestId: request.requestId, ok: true });
    await expect(result).resolves.toMatchObject({ requestId: request.requestId });
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it("handles a reply emitted synchronously by send", async () => {
    const f = fixture();
    f.send.mockImplementation(async (_target, _event, payload) => {
      f.receive({ requestId: (payload as WindowResponse).requestId, ok: true });
    });
    const result = f.start();
    f.install();
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it("propagates transport and server failures and cleans up", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("emit denied"));
    const result = f.start();
    f.install();
    await expect(result).rejects.toThrow("emit denied");
    expect(f.unlisten).toHaveBeenCalledTimes(1);
    const other = fixture();
    const failed = other.start();
    other.install();
    await vi.waitFor(() => expect(other.send).toHaveBeenCalled());
    other.receive({ requestId: (other.send.mock.calls[0][2] as WindowResponse).requestId, ok: false, error: "not a member" });
    await expect(failed).rejects.toThrow("not a member");
  });
  it("cancels before registration completes without sending and still removes late listener", async () => {
    const f = fixture();
    const controller = new AbortController();
    const result = f.start({ signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    f.install();
    await vi.waitFor(() => expect(f.unlisten).toHaveBeenCalledTimes(1));
    expect(f.send).not.toHaveBeenCalled();
  });
  it("times out while registering and disposes the late registration", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = expect(f.start()).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    f.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
  it("sends cancellation for an in-flight request and ignores late success", async () => {
    const f = fixture();
    const controller = new AbortController();
    const result = f.start({ signal: controller.signal });
    f.install();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(f.send.mock.calls[1][1]).toBe("cancel");
    f.receive({ requestId: (f.send.mock.calls[0][2] as WindowResponse).requestId, ok: true });
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });
});
