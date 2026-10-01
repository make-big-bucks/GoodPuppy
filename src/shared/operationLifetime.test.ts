import { describe, expect, it, vi } from "vitest";
import { createOperationLifetime } from "./operationLifetime.js";

describe("replaceable operation ownership", () => {
  it("invalidates old operations on close and reopen", () => {
    const lifetime = createOperationLifetime();
    const old = lifetime.capture();
    lifetime.invalidate();
    const next = lifetime.capture();
    expect(old.isCurrent()).toBe(false);
    expect(() => old.assertCurrent()).toThrow("操作已取消");
    expect(next.isCurrent()).toBe(true);
  });
  it("rejects a changed account independently of dialog replacement", () => {
    let account = "a";
    const lease = createOperationLifetime().capture(() => account === "a");
    account = "b";
    expect(lease.isCurrent()).toBe(false);
  });
  it("allows one pending submission and ignores stale submissions", async () => {
    const lifetime = createOperationLifetime();
    const lease = lifetime.capture();
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = lease.run(work);
    await lease.run(work);
    expect(work).toHaveBeenCalledTimes(1);
    lifetime.invalidate();
    finish(); await pending;
    await lease.run(work);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("releases submission ownership after failure so the same dialog can retry", async () => {
    const lease = createOperationLifetime().capture();
    await expect(lease.run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const retry = vi.fn(async () => {});
    await lease.run(retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
