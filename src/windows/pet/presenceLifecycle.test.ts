import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const flush = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
function fixture() {
  let status!: (value: string) => void; let hint!: (payload?: unknown) => void;
  const channel = { on: vi.fn((_type, _filter, handler) => { hint = handler; return channel; }),
    subscribe: vi.fn(handler => { status = handler; }), track: vi.fn(), presenceState: vi.fn() };
  let rows = [{ user_id: "friend", pet_id: "shiba", skin: "blue", status: "happy", remaining_ms: 100000 }];
  const rpc = vi.fn((name, _args) => {
    const promise = Promise.resolve({ data: name === "get_room_presence" ? rows : null, error: null });
    return Object.assign(promise, { abortSignal: () => promise });
  });
  const client = { channel: () => channel, rpc, removeChannel: vi.fn(async () => "ok") };
  return { channel, client, rpc, status: (value: string) => status(value), hint: (payload?: unknown) => hint(payload), setRows: (value: typeof rows) => { rows = value; } };
}
describe("trusted presence snapshots", () => {
  it("clears expired proofs even while a snapshot request is delayed", async () => {
    const api = await import("./presence.js"); const f = fixture(); const users = vi.fn();
    f.setRows([{ user_id: "friend", pet_id: "shiba", skin: "blue", status: "happy", remaining_ms: 100 }]);
    const joining = api.joinRoom(f.client as never, "room-a", "self", { onPresenceChange: users });
    await flush(); f.status("SUBSCRIBED"); await joining;
    await vi.advanceTimersByTimeAsync(101); f.hint();
    expect(users).toHaveBeenLastCalledWith([]); await api.leaveRoom();
  });
  it("does not apply an old snapshot after the session closes", async () => {
    const api = await import("./presence.js"); const f = fixture(); const users = vi.fn();
    const joining = api.joinRoom(f.client as never, "room-a", "self", { onPresenceChange: users });
    await flush(); f.status("SUBSCRIBED"); await joining;
    let finish!: (result: any) => void;
    const pending = new Promise<any>(resolve => { finish = resolve; });
    f.rpc.mockImplementationOnce(() => Object.assign(pending, { abortSignal: () => pending }));
    f.hint(); await vi.advanceTimersByTimeAsync(0); await api.leaveRoom();
    finish({ data: [{ user_id: "late", remaining_ms: 100000 }], error: null }); await flush();
    expect(users).toHaveBeenLastCalledWith([]);
  });
  it("discards an in-flight snapshot when its connection generation disconnects", async () => {
    const api = await import("./presence.js"); const f = fixture(); const users = vi.fn();
    const joining = api.joinRoom(f.client as never, "room-a", "self", { onPresenceChange: users });
    await flush(); f.status("SUBSCRIBED"); await joining;
    let finish!: (result: any) => void;
    const pending = new Promise<any>(resolve => { finish = resolve; });
    f.rpc.mockImplementationOnce(() => Object.assign(pending, { abortSignal: () => pending }));
    f.hint(); await vi.advanceTimersByTimeAsync(0);
    f.status("CHANNEL_ERROR"); expect(users).toHaveBeenLastCalledWith([]);
    finish({ data: [{ user_id: "stale", remaining_ms: 100000 }], error: null }); await flush();
    expect(users).toHaveBeenLastCalledWith([]);
    f.status("SUBSCRIBED"); await flush();
    expect(users).toHaveBeenLastCalledWith([expect.objectContaining({ userId: "friend" })]);
    await api.leaveRoom();
  });
  it("ignores forged broadcast identity and never consumes client Presence keys", async () => {
    const api = await import("./presence.js"); const f = fixture(); const users = vi.fn();
    const joining = api.joinRoom(f.client as never, "room-a", "self", { onPresenceChange: users, revision: 2 });
    await flush(); f.status("SUBSCRIBED"); await joining;
    f.hint({ user_id: "forged", skin: "pink", status: "busy" }); await vi.advanceTimersByTimeAsync(0);
    expect(users).toHaveBeenLastCalledWith([expect.objectContaining({ userId: "friend", skin: "blue", status: "happy" })]);
    expect(f.channel.track).not.toHaveBeenCalled(); expect(f.channel.presenceState).not.toHaveBeenCalled();
    await api.leaveRoom();
  });
  it("publishes only through guarded RPC and clears disconnected or closed snapshots", async () => {
    const api = await import("./presence.js"); const f = fixture(); const users = vi.fn();
    const joining = api.joinRoom(f.client as never, "room-a", "self", { onPresenceChange: users, revision: 4 });
    await flush(); f.status("SUBSCRIBED"); await joining;
    await api.updateLocalPresence({ status: "busy" });
    expect(f.rpc.mock.calls.filter(call => call[0] === "update_room_presence")).toHaveLength(0);
    await api.activatePresence();
    expect(f.rpc).toHaveBeenCalledWith("activate_room_presence", expect.objectContaining({ p_user: "self", p_room: "room-a", p_revision: 4, p_status: "busy" }));
    f.status("CHANNEL_ERROR"); expect(users).toHaveBeenLastCalledWith([]);
    await api.updateLocalPresence({ status: null }); f.status("SUBSCRIBED"); await flush();
    await api.heartbeatPresence(true);
    expect(f.rpc).toHaveBeenLastCalledWith("update_room_presence", expect.objectContaining({ p_status: null, p_connected: true }));
    await api.leaveRoom(); f.hint(); await vi.advanceTimersByTimeAsync(10000);
    expect(users).toHaveBeenLastCalledWith([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds broadcast refreshes while preserving the latest authoritative snapshot", async () => {
    const api = await import("./presence.js"); const f = fixture();
    const joining = api.joinRoom(f.client as never, "room-a", "self"); await flush(); f.status("SUBSCRIBED"); await joining;
    for(let i=0;i<100;i++) f.hint({ user_id: "forged" }); await vi.advanceTimersByTimeAsync(0);
    for(let i=0;i<100;i++) f.hint(); await vi.advanceTimersByTimeAsync(499);
    expect(f.rpc.mock.calls.filter(call=>call[0]==="get_room_presence")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.rpc.mock.calls.filter(call=>call[0]==="get_room_presence")).toHaveLength(3);
    await api.leaveRoom();
  });
});
