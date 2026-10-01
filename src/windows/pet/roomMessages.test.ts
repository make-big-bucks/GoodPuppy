import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
function fixture() {
  let status!: (value: string) => void;
  let insert!: (value: unknown) => void;
  const channel = { on: vi.fn((_event, _filter, handler) => { insert = handler; return channel; }),
    subscribe: vi.fn((handler) => { status = handler; return channel; }) };
  const limit = vi.fn(async () => ({ data: [{ id: "missed", content: "补回", sender_id: "friend", created_at: "2026-10-01T00:00:00Z", kind: "text" }], error: null }));
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit };
  const client = { channel: () => channel, from: vi.fn(() => query), removeChannel: vi.fn(async () => "ok") };
  return { client, query, limit, status: (value: string) => status(value), insert: (value: unknown) => insert({ new: value }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("room message reconnection", () => {
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
