import { describe, expect, it, vi } from "vitest";
import { createRefreshController } from "./refreshController.js";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
describe("session-owned refresh", () => {
  it("drops old account results and errors while letting a new account load immediately", async () => {
    const old = deferred<string>(); const commit = vi.fn(); const error = vi.fn();
    const load = vi.fn((user: string) => user === "a" ? old.promise : Promise.resolve("b-data"));
    const controller = createRefreshController({ load, commit, error });
    controller.setContext("a"); const first = controller.refresh(); await Promise.resolve();
    controller.setContext("b"); await controller.refresh();
    expect(commit).toHaveBeenCalledWith("b-data", "b");
    old.reject(new Error("late a error")); await first;
    expect(error).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledTimes(1);
  });
  it("coalesces a burst into one rerun and commits the freshest snapshot", async () => {
    const first = deferred<string>(); const commit = vi.fn();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("fresh");
    const controller = createRefreshController({ load, commit, error: vi.fn() });
    controller.setContext("user"); const pending = controller.refresh(); await Promise.resolve();
    for (let i = 0; i < 50; i++) expect(controller.refresh()).toBe(pending);
    first.resolve("stale"); await pending;
    expect(load).toHaveBeenCalledTimes(2); expect(commit.mock.calls).toEqual([["fresh", "user"]]);
  });
  it("cancels the previous signal on logout without rendering late success", async () => {
    const first = deferred<string>(); let signal!: AbortSignal; const commit = vi.fn();
    const controller = createRefreshController({ load: (_user: string, next: AbortSignal) => { signal = next; return first.promise; }, commit, error: vi.fn() });
    controller.setContext("user"); const pending = controller.refresh(); await Promise.resolve();
    controller.setContext(null); expect(signal.aborted).toBe(true);
    first.resolve("old"); await pending; expect(commit).not.toHaveBeenCalled();
  });
});
