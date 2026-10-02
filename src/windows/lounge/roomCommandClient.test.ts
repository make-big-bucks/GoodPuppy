import { expect, it, vi } from "vitest";
import { createRoomCommandClient } from "./roomCommandClient.js";
function fixture() {
  const abort = new AbortController(); const entered = vi.fn(async () => {});
  const request = vi.fn(async () => ({ requestId: "id", ok: true, action: "enter" as const, requestedRoomId: "room", roomId: "room" }));
  const synchronize = vi.fn(async () => {});
  const client = createRoomCommandClient({ context: () => ({ userId: "self", signal: abort.signal }),
    request, synchronize, currentRoom: () => "room", entered });
  return { client, abort, request, synchronize, entered };
}
it("hides only after both the command and the current snapshot are confirmed", async () => {
  const f = fixture(); let finish!: () => void;
  f.synchronize.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const work = f.client.change("enter", "room"); await Promise.resolve();
  expect(f.entered).not.toHaveBeenCalled(); finish(); await work; expect(f.entered).toHaveBeenCalledTimes(1);
});
it("does not hide when identity invalidates during snapshot synchronization", async () => {
  const f = fixture(); f.synchronize.mockImplementation(async () => { f.abort.abort(); });
  await expect(f.client.change("enter", "room")).rejects.toMatchObject({ name: "AbortError" });
  expect(f.entered).not.toHaveBeenCalled();
});
it("rejects a mismatched room receipt before requesting or hiding another scene", async () => {
  const f = fixture(); f.request.mockResolvedValue({ requestId: "id", ok: true, action: "enter", requestedRoomId: "other", roomId: "other" });
  await expect(f.client.change("enter", "room")).rejects.toThrow("房间回复与请求不一致");
  expect(f.synchronize).not.toHaveBeenCalled(); expect(f.entered).not.toHaveBeenCalled();
});

it("never hides on a failed receipt even if its room fields happen to match", async () => {
  const f = fixture(); f.request.mockResolvedValue({ requestId: "id", ok: false, action: "enter", requestedRoomId: "room", roomId: "room", error: "entry denied" } as never);
  await expect(f.client.change("enter", "room")).rejects.toThrow("entry denied");
  expect(f.synchronize).not.toHaveBeenCalled(); expect(f.entered).not.toHaveBeenCalled();
});
