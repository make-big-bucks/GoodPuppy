import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
describe("presence connection lifecycle", () => {
  it("clears disconnected peers, ignores stale sync and tracks buffered appearance on reconnect", async () => {
    const api = await import("./presence.js");
    let status!: (value: string) => void; let sync!: () => void;
    const channel = { on: vi.fn((_type, _event, handler) => { sync = handler; }),
      subscribe: vi.fn((handler) => { status = handler; }), track: vi.fn(async () => "ok"),
      unsubscribe: vi.fn(async () => "ok"), presenceState: () => ({ friend: [{ pet_id: "shiba", skin: "blue" }] }) };
    const client = { channel: () => channel }; const users = vi.fn();
    const joining = api.joinRoom(client as never, "room-a", "self", { onPresenceChange: users });
    status("SUBSCRIBED"); await joining;
    expect(users).toHaveBeenLastCalledWith([expect.objectContaining({ userId: "friend" })]);
    status("CHANNEL_ERROR"); expect(users).toHaveBeenLastCalledWith([]);
    sync(); expect(users).toHaveBeenLastCalledWith([]);
    const calls = channel.track.mock.calls.length;
    await api.updateLocalPresence({ skin: "red", status: null });
    expect(channel.track).toHaveBeenCalledTimes(calls);
    status("SUBSCRIBED"); await flush();
    expect(channel.track).toHaveBeenLastCalledWith(expect.objectContaining({ skin: "red", status: null }));
    expect(users).toHaveBeenLastCalledWith([expect.objectContaining({ userId: "friend" })]);
    await api.leaveRoom(); sync(); expect(users).toHaveBeenLastCalledWith([]);
  });
});
