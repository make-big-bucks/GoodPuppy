import { describe, expect, it, vi } from "vitest";
import { createSkinSelection, type SkinSelectionSnapshot } from "./skinSelection.js";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
  const render = vi.fn<(snapshot: SkinSelectionSnapshot) => void>(); const saved = vi.fn(); const closed = vi.fn(); const error = vi.fn();
  const load = vi.fn(async () => ({ skins: ["blue", "pink"], states: ["idle", "happy"] }));
  const persist = vi.fn(async (_context: { petId: string; skin: string; userId: string }, _skin: string) => {});
  const selection = createSkinSelection({ ownerKey: (context) => context.userId, load, persist, render, saved, closed, error });
  const context = { petId: "shiba", skin: "default", userId: "a" };
  const snapshot = () => render.mock.calls.at(-1)![0];
  return { selection, load, persist, render, saved, closed, error, context, snapshot };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
describe("skin selection ownership", () => {
  it("captures identity fields instead of following a reused mutable context object", async () => {
    const f = fixture(); f.selection.open(f.context); f.context.userId = "b"; await flush(); f.selection.select("blue");
    await f.selection.save();
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({ userId: "a" }), "blue");
  });
  it("broadcasts and closes only after persistence succeeds, with one pending submission", async () => {
    const f = fixture(); f.selection.open(f.context); await flush(); f.selection.select("blue");
    const update = deferred<void>(); f.persist.mockReturnValueOnce(update.promise);
    const saving = f.selection.save(); await f.selection.save(); await flush();
    expect(f.persist).toHaveBeenCalledTimes(1); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed).not.toHaveBeenCalled();
    expect(f.snapshot().busy).toBe(true); f.selection.select("pink"); expect(f.snapshot().skin).toBe("blue");
    update.resolve(); await saving;
    expect(f.saved).toHaveBeenCalledWith(f.context, "blue"); expect(f.closed).toHaveBeenCalledTimes(1);
  });
  it("keeps the unsaved choice and allows retry after failure", async () => {
    const f = fixture(); f.selection.open(f.context); await flush(); f.selection.select("blue");
    f.persist.mockRejectedValueOnce(new Error("denied")); await f.selection.save();
    expect(f.snapshot()).toMatchObject({ skin: "blue", savedSkin: "default", busy: false });
    expect(f.error).toHaveBeenCalledTimes(1); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed).not.toHaveBeenCalled();
    await f.selection.save(); expect(f.saved).toHaveBeenCalledWith(f.context, "blue");
  });
  it("delivers committed data with the captured account without mutating another account's panel", async () => {
    const f = fixture(); f.selection.open(f.context); await flush(); f.selection.select("blue");
    const update = deferred<void>(); f.persist.mockReturnValueOnce(update.promise); const saving = f.selection.save(); await flush();
    f.selection.open({ ...f.context, userId: "b", skin: "pink" }); await flush();
    update.resolve(); await saving;
    expect(f.snapshot().skin).toBe("pink"); expect(f.saved).toHaveBeenCalledWith(f.context, "blue"); expect(f.closed).toHaveBeenCalledTimes(1);
  });
  it("ignores delayed metadata from an old character and rejects unavailable skins", async () => {
    const f = fixture(); const options = deferred<{ skins: string[]; states: string[] }>(); f.load.mockReturnValueOnce(options.promise);
    f.selection.open(f.context); f.selection.open({ ...f.context, petId: "ghost" }); await flush();
    options.resolve({ skins: ["old"], states: ["old-animation"] }); await flush();
    expect(f.snapshot().skins).toEqual(["default", "blue", "pink"]);
    f.selection.select("old"); expect(f.snapshot().skin).toBe("default");
  });
  it("ignores a delayed save failure after closing", async () => {
    const f = fixture(); f.selection.open(f.context); await flush(); f.selection.select("blue");
    const update = deferred<void>(); f.persist.mockReturnValueOnce(update.promise); const saving = f.selection.save(); await flush();
    f.selection.close(); update.reject(new Error("offline")); await saving;
    expect(f.error).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled();
  });
  it("syncs authoritative saved skin without discarding a different preview choice", async () => {
    const f = fixture(); f.selection.open(f.context); await flush();
    f.selection.syncSaved("other-account", "pink"); expect(f.snapshot().skin).toBe("default");
    f.selection.syncSaved("a", "blue"); expect(f.snapshot()).toMatchObject({ skin: "blue", savedSkin: "blue" });
    f.selection.select("pink"); f.selection.syncSaved("a", "default");
    expect(f.snapshot()).toMatchObject({ skin: "pink", savedSkin: "default" });
  });
  it("serializes same-account writes across close/reopen so an older request cannot overwrite the new choice", async () => {
    const f = fixture(); f.selection.open(f.context); await flush(); f.selection.select("blue");
    const update = deferred<void>(); f.persist.mockReturnValueOnce(update.promise);
    const oldSave = f.selection.save(); await flush();
    f.selection.close(); f.selection.open(f.context); await flush(); f.selection.select("pink");
    const newSave = f.selection.save(); await flush(); expect(f.persist).toHaveBeenCalledTimes(1);
    update.resolve(); await oldSave; await newSave;
    expect(f.persist.mock.calls.map((call) => call[1])).toEqual(["blue", "pink"]);
    expect(f.saved).toHaveBeenCalledTimes(2); expect(f.saved).toHaveBeenLastCalledWith(f.context, "pink");
  });
});
