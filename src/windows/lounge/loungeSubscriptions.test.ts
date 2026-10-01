import { describe, expect, it, vi } from "vitest";
import { createLoungeSubscriptions } from "./loungeSubscriptions.js";
function client() {
  const channels: any[] = [];
  const value = { channel: vi.fn((name) => {
    const channel = { name, filter: null as any, callback: null as any, status: null as any,
      on: vi.fn((_type, filter, callback) => { channel.filter = filter; channel.callback = callback; return channel; }),
      subscribe: vi.fn((callback) => { channel.status = callback; return channel; }) };
    channels.push(channel); return channel;
  }), removeChannel: vi.fn(async () => "ok") };
  return { value, channels };
}
function fixture() {
  const refresh = vi.fn(); const presenceChanged = vi.fn(); const error = vi.fn();
  const subscriptions = createLoungeSubscriptions({ refresh, presenceChanged, error, knownMemberIds: () => new Set(["self", "friend"]) });
  return { subscriptions, refresh, presenceChanged, error };
}
describe("lounge subscription ownership", () => {
  it("releases partially created channels and can retry the same identity after setup failure", () => {
    const f = fixture(); const c = client(); const create = c.value.channel.getMockImplementation()!;
    c.value.channel.mockImplementationOnce(create).mockImplementationOnce(() => { throw new Error("creation failed"); });
    f.subscriptions.setContext({ client: c.value as never, userId: "self" });
    expect(c.value.removeChannel).toHaveBeenCalledTimes(1); expect(f.error).toHaveBeenCalledTimes(1);
    c.channels[0].status("SUBSCRIBED"); expect(f.refresh).not.toHaveBeenCalled();
    f.subscriptions.setContext({ client: c.value as never, userId: "self" }); expect(c.channels).toHaveLength(6);
    f.subscriptions.dispose();
  });
  it("does not stop releasing other channels when one removal rejects", async () => {
    const f = fixture(); const c = client();
    c.value.removeChannel.mockRejectedValueOnce(new Error("cleanup failed"));
    f.subscriptions.setContext({ client: c.value as never, userId: "self" }); f.subscriptions.dispose();
    await Promise.resolve(); expect(c.value.removeChannel).toHaveBeenCalledTimes(5); expect(f.error).toHaveBeenCalledTimes(1);
  });
  it("keeps subscriptions on token refresh and refreshes snapshots after reconnection", () => {
    const f = fixture(); const c = client();
    f.subscriptions.setContext({ client: c.value as never, userId: "self" });
    f.subscriptions.setContext({ client: c.value as never, userId: "self" });
    expect(c.channels).toHaveLength(5);
    c.channels[0].status("SUBSCRIBED"); c.channels[0].status("SUBSCRIBED");
    expect(f.refresh).toHaveBeenCalledTimes(2); f.subscriptions.dispose();
  });
  it("invalidates old callbacks and releases them with their creating client", () => {
    const f = fixture(); const old = client(); const next = client();
    f.subscriptions.setContext({ client: old.value as never, userId: "self" });
    f.subscriptions.setContext({ client: next.value as never, userId: "other" });
    expect(old.value.removeChannel).toHaveBeenCalledTimes(5); expect(next.value.removeChannel).not.toHaveBeenCalled();
    old.channels[4].callback({ new: { user_id: "friend" } }); old.channels[0].status("SUBSCRIBED");
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.presenceChanged).not.toHaveBeenCalled();
    f.subscriptions.dispose();
  });
  it("uses fresh topic names when relogging into the same client while removal is pending", () => {
    const f = fixture(); const c = client(); c.value.removeChannel.mockReturnValue(new Promise(() => {}));
    f.subscriptions.setContext({ client: c.value as never, userId: "self" }); const names = c.channels.map(c => c.name);
    f.subscriptions.setContext(null); f.subscriptions.setContext({ client: c.value as never, userId: "self" });
    expect(c.channels.slice(5).every(c => !names.includes(c.name))).toBe(true); f.subscriptions.dispose();
  });
  it("filters unrelated profiles and reports failures without accepting stale status", () => {
    const f = fixture(); const c = client(); f.subscriptions.setContext({ client: c.value as never, userId: "self" });
    const profile = c.channels.find(c => c.filter.table === "profiles");
    profile.callback({ new: { id: "stranger" } }); expect(f.refresh).not.toHaveBeenCalled();
    profile.callback({ new: { id: "friend" } }); expect(f.refresh).toHaveBeenCalledTimes(1);
    profile.status("CHANNEL_ERROR", new Error("offline")); expect(f.error).toHaveBeenCalledTimes(1);
    f.subscriptions.dispose(); profile.status("CHANNEL_ERROR"); expect(f.error).toHaveBeenCalledTimes(1);
  });
});
