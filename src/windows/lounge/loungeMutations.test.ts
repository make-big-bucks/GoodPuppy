import { describe, expect, it, vi } from "vitest";
import { sendRoomInvitation } from "./loungeMutations.js";

function fixture() {
  let resolve!: (result: unknown) => void;
  const lookup = new Promise((done) => { resolve = done; });
  const filters: unknown[][] = [];
  const rpc = vi.fn(async () => ({ error: null }));
  const client = { rpc, from: (table: string) => ({ select: () => ({ eq: (key: string, value: string) => {
    filters.push([table, key, value]);
    return table === "profiles" ? { single: () => lookup } : { eq: () => ({ maybeSingle: async () => ({ data: null }) }) };
  } }) }) };
  let current = true;
  const context = { client: client as never, userId: "self", roomId: "original-room", assertCurrent() {
    if (!current) throw new DOMException("账号已改变", "AbortError");
  } };
  return { context, rpc, filters, resolve, changeAccount: () => { current = false; } };
}
describe("invitation mutation context", () => {
  it("keeps the captured room across a delayed identity lookup", async () => {
    const f = fixture();
    const result = sendRoomInvitation(f.context, "gp_1234567890");
    f.resolve({ data: { id: "friend" }, error: null });
    await result;
    expect(f.filters).toContainEqual(["room_members", "room_id", "original-room"]);
    expect(f.rpc).toHaveBeenCalledWith("invite_room_member", { p_room_id: "original-room", p_to_user_id: "friend" });
  });
  it("does not send an invitation after the account changes during lookup", async () => {
    const f = fixture();
    const result = sendRoomInvitation(f.context, "gp_1234567890");
    f.changeAccount();
    f.resolve({ data: { id: "friend" }, error: null });
    await expect(result).rejects.toThrow("账号已改变");
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
