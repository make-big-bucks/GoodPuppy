import { describe, expect, it, vi } from "vitest";
import { executeRoomCommand, isRoomCommand, type RoomCommand } from "./roomProtocol.js";
const command: RoomCommand = { requestId: "r1", replyTo: "lounge", action: "enter", roomId: "room-a" };
describe("room command replies", () => {
  it("validates control payloads and reply target", () => {
    expect(isRoomCommand(command)).toBe(true);
    expect(isRoomCommand({ ...command, replyTo: "bubble-self" })).toBe(false);
    expect(isRoomCommand({ ...command, roomId: null })).toBe(false);
  });
  it("replies only after visibility completes and matches the room", async () => {
    const sync = vi.fn(async () => {});
    const result = await executeRoomCommand(command, { enter: async () => {}, exit: async () => {}, sync, getRevision: () => 1, getRoomId: () => "room-b" });
    expect(sync).toHaveBeenCalled();
    expect(result).toMatchObject({ requestId: "r1", ok: false, roomId: "room-b" });
  });
  it("still synchronizes local visibility when exit cleanup fails", async () => {
    const sync = vi.fn(async () => {});
    const result = await executeRoomCommand({ ...command, action: "exit" }, {
      enter: async () => {}, exit: async () => { throw new Error("network failure"); }, sync, getRevision: () => 1, getRoomId: () => null,
    });
    expect(sync).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: "network failure", roomId: null });
  });
  it("rolls back its own entered room when window preparation fails", async () => {
    let roomId: string | null = "room-a";
    const exit = vi.fn(async () => { roomId = null; });
    const sync = vi.fn().mockRejectedValueOnce(new Error("spawn failed")).mockResolvedValue(undefined);
    const result = await executeRoomCommand(command, {
      enter: async () => {}, exit, sync, getRevision: () => 1, getRoomId: () => roomId,
    });
    expect(exit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: "spawn failed", roomId: null });
  });

});
