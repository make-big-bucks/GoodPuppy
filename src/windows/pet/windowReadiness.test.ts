import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventSubscription } from "../../shared/eventSubscription.js";
import { createPresenterEndpoint, createWindowReadiness, WINDOW_READY, WINDOW_READY_REQUEST } from "./windowReadiness.js";

function bus() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    listen<T>(event: string, handler: (payload: T) => void) {
      return createEventSubscription<T>(async (callback) => {
        handlers.set(event, callback as (payload: unknown) => void);
        return () => handlers.delete(event);
      }, handler);
    },
    emit(event: string, payload: unknown) { handlers.get(event)?.(payload); },
  };
}
afterEach(() => vi.useRealTimers());
describe("presenter readiness and instance protocol", () => {
  it("ignores stale readiness and confirms the current controller handshake", async () => {
    const events = bus(); const send = vi.fn(async () => {});
    const broker = createWindowReadiness({ controllerId: "controller", listen: events.listen, send });
    await broker.ready;
    let completed = false;
    const ready = broker.wait("pet-a", "new").then(() => { completed = true; });
    events.emit(WINDOW_READY, { label: "pet-a", instanceId: "old", controllerId: "controller" });
    expect(send).not.toHaveBeenCalled();
    events.emit(WINDOW_READY, { label: "pet-a", instanceId: "new", controllerId: null });
    expect(send).toHaveBeenCalledWith("pet-a", WINDOW_READY_REQUEST, { instanceId: "new", controllerId: "controller" });
    expect(completed).toBe(false);
    events.emit(WINDOW_READY, { label: "pet-a", instanceId: "new", controllerId: "controller" });
    await ready; expect(completed).toBe(true); broker.dispose();
  });
  it("rejects and removes aborted or timed-out waits so retry is possible", async () => {
    vi.useFakeTimers();
    const events = bus();
    const broker = createWindowReadiness({ controllerId: "controller", listen: events.listen, send: async () => {} });
    await broker.ready;
    const abort = new AbortController();
    const first = expect(broker.wait("bubble-self", "one", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await first;
    const timeout = expect(broker.wait("bubble-self", "one", undefined, 100)).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100); await timeout;
    const retry = broker.wait("bubble-self", "one");
    events.emit(WINDOW_READY, { label: "bubble-self", instanceId: "one", controllerId: "controller" });
    await retry; broker.dispose();
  });
  it("drops old instance, old controller and out-of-order data without replaying old history", async () => {
    const events = bus(); const render = vi.fn();
    const endpoint = createPresenterEndpoint({ label: "bubble-a", instanceId: "new", listen: events.listen, send: async () => {} });
    endpoint.listen("history", render); await endpoint.ready();
    events.emit(WINDOW_READY_REQUEST, { instanceId: "new", controllerId: "root" });
    events.emit("history", { instanceId: "old", controllerId: "root", sequence: 99, payload: "old window" });
    events.emit("history", { instanceId: "new", controllerId: "root", sequence: 2, payload: "latest" });
    events.emit("history", { instanceId: "new", controllerId: "root", sequence: 1, payload: "old snapshot" });
    expect(render.mock.calls).toEqual([["latest"]]);
    events.emit(WINDOW_READY_REQUEST, { instanceId: "new", controllerId: "new-root" });
    events.emit("history", { instanceId: "new", controllerId: "root", sequence: 100, payload: "old controller" });
    events.emit("history", { instanceId: "new", controllerId: "new-root", sequence: 1, payload: "restored" });
    expect(render.mock.calls).toEqual([["latest"], ["restored"]]);
    endpoint.dispose();
  });
  it("a late old ping failure cannot remove a new wait for the same persistent panel", async () => {
    const events = bus();
    let fail!: (error: Error) => void;
    const send = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const broker = createWindowReadiness({ controllerId: "root", listen: events.listen, send });
    await broker.ready;
    const abort = new AbortController();
    const old = expect(broker.wait("bubble-self", "panel", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    events.emit(WINDOW_READY, { label: "bubble-self", instanceId: "panel", controllerId: null });
    abort.abort(); await old;
    const current = broker.wait("bubble-self", "panel");
    fail(new Error("old ping failed")); await Promise.resolve(); await Promise.resolve();
    events.emit(WINDOW_READY, { label: "bubble-self", instanceId: "panel", controllerId: "root" });
    await current; broker.dispose();
  });

});
