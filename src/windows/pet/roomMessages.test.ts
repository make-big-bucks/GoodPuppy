import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  let status!: (value: string) => void;
  let insert!: (value: unknown) => void;
  const channel = { on: vi.fn((_event, _filter, handler) => { insert = handler; return channel; }),
    subscribe: vi.fn((handler) => { status = handler; return channel; }) };
  const limit = vi.fn(async () => ({ data: [{ id: "missed", content: "补回", sender_id: "friend", created_at: "2026-10-01T00:00:00Z", kind: "text" }], error: null }));
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockReturnThis(), limit };
  const client = { channel: () => channel, from: vi.fn(() => query), removeChannel: vi.fn(async () => "ok") };
  return { client, query, limit, status: (value: string) => status(value), insert: (value: unknown) => insert({ new: value }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("room message reconnection", () => {
  it("retries a failed recovery while staying unready, and cancels scheduled retries on exit", async () => {
    const api = await import("./roomMessages.js"); const f = fixture(); const receive = vi.fn(); const health = vi.fn();
    const joining = api.subscribeToRoomMessages(f.client as never, "room-a", receive, health);
    await flush(); f.status("SUBSCRIBED"); await joining;
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    f.limit.mockResolvedValueOnce({ data: null, error: new Error("HTTP down") } as never);
    f.status("SUBSCRIBED"); await flush();
    expect(health).toHaveBeenLastCalledWith(false, undefined);
    expect(receive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ id: "missed" }));
    expect(health).toHaveBeenLastCalledWith(true, undefined);
    f.limit.mockResolvedValueOnce({ data: null, error: new Error("HTTP down") } as never);
    f.status("SUBSCRIBED"); await flush();
    const signal = f.query.abortSignal.mock.calls.at(-1)![0] as AbortSignal;
    const calls = f.limit.mock.calls.length;
    await api.unsubscribeRoomMessages(f.client as never);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.limit).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it("reloads bounded history on reconnect and discards old-channel events after leaving", async () => {
    const api = await import("./roomMessages.js"); const f = fixture(); const receive = vi.fn();
    const joining = api.subscribeToRoomMessages(f.client as never, "room-a", receive);
    await flush(); f.status("SUBSCRIBED"); await joining;
    expect(f.client.from).not.toHaveBeenCalled();
    f.status("SUBSCRIBED"); await flush();
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ id: "missed", from: "friend" }));
    expect(f.query.order).toHaveBeenCalledWith("id", { ascending: false });
    await api.unsubscribeRoomMessages(f.client as never); receive.mockClear();
    f.insert({ id: "late", kind: "text" }); f.status("SUBSCRIBED"); await flush();
    expect(receive).not.toHaveBeenCalled();
  });
  it("ignores a recovery snapshot when the channel disconnects during its query", async () => {
    const api = await import("./roomMessages.js"); const f = fixture(); const receive = vi.fn();
    const joining = api.subscribeToRoomMessages(f.client as never, "room-a", receive);
    await flush(); f.status("SUBSCRIBED"); await joining;
    let finish!: (value: any) => void;
    f.limit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.status("SUBSCRIBED"); await flush();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.status("CHANNEL_ERROR"); finish({ data: [{ id: "stale", kind: "text" }], error: null }); await flush();
    expect(receive).not.toHaveBeenCalled();
    await api.unsubscribeRoomMessages(f.client as never); log.mockRestore();
  });
});
