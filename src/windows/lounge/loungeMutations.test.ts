import { describe, expect, it, vi } from "vitest";
import { saveDisplayName, saveRoomMetadata, sendRoomInvitation } from "./loungeMutations.js";

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

function writeFixture() {
  const single = vi.fn(async () => ({ data: { id: "target-room" }, error: null }));
  const query = { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single };
  const from = vi.fn(() => query); let current = true;
  const context = { client: { from } as never, userId: "self", roomId: "different-selection", assertCurrent() {
    if (!current) throw new DOMException("账号已改变", "AbortError");
  } };
  return { context, query, from, changeAccount: () => { current = false; } };
}
describe("profile and room write receipts", () => {
  it("updates the captured room target and requires a receipt for that target", async () => {
    const f = writeFixture();
    await saveRoomMetadata(f.context, "target-room", { roomName: " 测试 ", description: " 简介 " });
    expect(f.from).toHaveBeenCalledWith("rooms"); expect(f.query.eq).toHaveBeenCalledWith("id", "target-room");
    expect(f.query.update).toHaveBeenCalledWith({ room_name: "测试", description: "简介" });
    f.query.single.mockResolvedValue({ data: { id: "other-room" }, error: null });
    await expect(saveRoomMetadata(f.context, "target-room", { roomName: "测试", description: "" })).rejects.toThrow("房间资料未保存");
  });
  it("propagates a zero-row profile response instead of reporting a save", async () => {
    const f = writeFixture();
    f.query.single.mockResolvedValue({ data: null, error: { code: "PGRST116" } } as never);
    await expect(saveDisplayName(f.context, "泡芙")).rejects.toMatchObject({ code: "PGRST116" });
    expect(f.query.eq).toHaveBeenCalledWith("id", "self"); expect(f.query.select).toHaveBeenCalledWith("id");
  });
  it("invalidates a successful old-account receipt before its caller refreshes", async () => {
    const f = writeFixture(); let finish!: (value: any) => void;
    f.query.single.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const work = saveDisplayName(f.context, "泡芙"); f.changeAccount();
    finish({ data: { id: "self" }, error: null });
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
  });
});
