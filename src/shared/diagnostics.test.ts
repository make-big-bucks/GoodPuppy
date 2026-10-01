import { afterEach, describe, expect, it, vi } from "vitest";
import { recordLifecycle } from "./diagnostics.js";
afterEach(() => vi.unstubAllGlobals());
describe("lifecycle diagnostic isolation", () => {
  it("records correlation fields without changing an operation when logging fails", async () => {
    const recordDiagnostic = vi.fn(async () => { throw new Error("log unavailable"); });
    vi.stubGlobal("window", { goodPuppy: { recordDiagnostic } });
    const event = { operation: "room-enter" as const, phase: "start" as const, roomId: "room-a", requestId: "request-a", sessionVersion: 2 };
    expect(() => recordLifecycle(event)).not.toThrow();
    await Promise.resolve(); expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining(event));
  });
  it("supports non-desktop tests without requiring a bridge", () => {
    vi.stubGlobal("window", {});
    expect(() => recordLifecycle({ operation: "room-enter", phase: "ok" })).not.toThrow();
  });
  it("also isolates a synchronous bridge exception", () => {
    vi.stubGlobal("window", { goodPuppy: { recordDiagnostic: () => { throw new Error("bridge closed"); } } });
    expect(() => recordLifecycle({ operation: "room-enter", phase: "ok" })).not.toThrow();
  });
});
