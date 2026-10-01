import { describe, expect, it, vi } from "vitest";
import { createEventSubscription } from "./eventSubscription.js";
import { isRoomState, isRoomStateRequest, requestRoomState, ROOM_STATE_QUERY } from "./roomState.js";
function transport(state: unknown) {
  let deliver!: (value: any) => void;
  const send = vi.fn(async (_target, _event, payload) => {
    deliver({ requestId: payload.requestId, ok: true, ...(state as object) });
  });
  return { send, listen: (_event: string, callback: any) => createEventSubscription(async handler => {
    deliver = handler; return () => {};
  }, callback) };
}
describe("authoritative room state", () => {
  it("waits for a correlated main reply carrying the current account and revision", async () => {
    const t = transport({ controllerId: "main-instance", userId: "self", roomId: "current-room", revision: 8 });
    expect(await requestRoomState(t, "self", new AbortController().signal)).toMatchObject({ roomId: "current-room", revision: 8 });
    expect(t.send).toHaveBeenCalledWith("main", ROOM_STATE_QUERY, expect.objectContaining({ replyTo: "lounge", userId: "self" }));
  });
  it("rejects another account's reply even when its request ID matches", async () => {
    const t = transport({ controllerId: "old-instance", userId: "old", roomId: "old-room", revision: 9 });
    await expect(requestRoomState(t, "self", new AbortController().signal)).rejects.toThrow("当前账号不一致");
  });
  it("rejects malformed state and unapproved reply destinations", () => {
    expect(isRoomState({ controllerId: "main-instance", userId: "self", roomId: null, revision: -1 })).toBe(false);
    expect(isRoomState({ userId: "self", revision: 2 })).toBe(false);
    expect(isRoomState({ controllerId: "main-instance", userId: null, roomId: "private", revision: 2 })).toBe(false);
    expect(isRoomStateRequest({ requestId: "id", userId: "self", replyTo: "pet-other" })).toBe(false);
    expect(isRoomStateRequest({ requestId: "id", userId: null, replyTo: "lounge" })).toBe(true);
  });
});
