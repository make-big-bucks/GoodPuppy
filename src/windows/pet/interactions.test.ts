import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
function fixture() {
  let status!: (value: string) => void;
  let broadcast!: (value: { payload: unknown }) => void;
  const channel = {
    on: vi.fn((_type, _event, handler) => { broadcast = handler; return channel; }),
    subscribe: vi.fn((handler) => { status = handler; return channel; }),
    unsubscribe: vi.fn(async () => "ok"),
    send: vi.fn(),
  };
  const client = { channel: vi.fn(() => channel), rpc: vi.fn(async () => ({ error: null })) };
  return { channel, client, subscribed: () => status("SUBSCRIBED"), broadcast: (payload: unknown) => broadcast({ payload }) };
}
describe("authorized interaction delivery", () => {
  it("waits for private channel readiness and delegates actor identity to the server", async () => {
    const api = await import("./interactions.js");
    const f = fixture();
    const joining = api.joinInteractions(f.client as never, "room-a");
    await expect(api.sendInteraction({ action: "feed", actorId: "forged", targetId: "target" })).rejects.toThrow("尚未就绪");
    expect(f.client.channel).toHaveBeenCalledWith("interactions:room-a", { config: { private: true, broadcast: { self: false } } });
    f.subscribed();
    await joining;
    await api.sendInteraction({ action: "feed", actorId: "forged", targetId: "target" });
    expect(f.client.rpc).toHaveBeenCalledWith("send_room_interaction", { p_room_id: "room-a", p_action: "feed", p_target_id: "target" });
    expect(f.channel.send).not.toHaveBeenCalled();
    await api.leaveInteractions();
  });
  it("ignores old channel events after leaving and propagates RPC rejection", async () => {
    const api = await import("./interactions.js");
    const f = fixture();
    const receive = vi.fn();
    const joining = api.joinInteractions(f.client as never, "room-a", { onInteraction: receive });
    f.subscribed(); await joining;
    f.client.rpc.mockResolvedValueOnce({ error: new Error("not a member") } as never);
    await expect(api.sendInteraction({ action: "feed", actorId: "actor", targetId: "target" })).rejects.toThrow("not a member");
    await api.leaveInteractions();
    f.broadcast({ action: "feed", actorId: "actor", targetId: "target" });
    expect(receive).not.toHaveBeenCalled();
  });
});
