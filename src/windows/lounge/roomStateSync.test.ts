import { describe, expect, it, vi } from "vitest";
import { createRoomStateSync } from "./roomStateSync.js";
import type { RoomState } from "../../shared/roomState.js";
function deferred() {
  let resolve!: (state: RoomState) => void;
  const promise = new Promise<RoomState>(done => { resolve = done; }); return { resolve, promise };
}
const state = (revision: number, roomId: string, controllerId = "main-a"): RoomState => ({ userId: "self", controllerId, revision, roomId });
function fixture() {
  const abort = new AbortController(); const read = vi.fn(); const changed = vi.fn();
  const cache = createRoomStateSync({ context: () => ({ userId: "self", signal: abort.signal }), read, changed, failed: vi.fn() });
  return { cache, read, changed, abort };
}
describe("room state snapshot ownership", () => {
  it("waits for the latest overlapping read and never applies the older reply", async () => {
    const f = fixture(); const old = deferred(); const next = deferred();
    f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = f.cache.sync(); const second = f.cache.sync();
    let finished = false; void first.then(() => { finished = true; });
    old.resolve(state(1, "old")); await Promise.resolve(); expect(finished).toBe(false);
    next.resolve(state(2, "new")); await Promise.all([first, second]);
    expect(f.cache.roomId).toBe("new"); expect(f.changed).toHaveBeenCalledTimes(1);
  });
  it("ignores older broadcasts and confirms a new controller before resetting its version", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(state(10, "current")); await f.cache.sync();
    f.cache.receive(state(9, "old")); expect(f.cache.roomId).toBe("current");
    const next = deferred(); f.read.mockReturnValueOnce(next.promise);
    f.cache.receive(state(1, "unconfirmed", "main-b")); expect(f.cache.roomId).toBe("current");
    next.resolve(state(1, "reloaded", "main-b")); await next.promise; await Promise.resolve();
    expect(f.cache.roomId).toBe("reloaded");
  });
  it("reset invalidates an in-flight read even when account and signal remain unchanged", async () => {
    const f = fixture(); const pending = deferred(); f.read.mockReturnValueOnce(pending.promise);
    const work = f.cache.sync(); const rejection = expect(work).rejects.toMatchObject({ name: "AbortError" });
    f.cache.reset(); pending.resolve(state(5, "old")); await rejection;
    expect(f.cache.roomId).toBeNull(); expect(f.changed).not.toHaveBeenCalled();
  });
});
