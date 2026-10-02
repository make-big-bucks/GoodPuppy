import { expect, it, vi } from "vitest";
import { createResourceLifetime } from "./resourceLifetime.js";
it("releases all resources once even when an earlier release fails", () => {
  const failed = vi.fn(); const scope = createResourceLifetime(failed); const next = vi.fn();
  scope.own(() => { throw new Error("release failed"); }); scope.own(next);
  scope.dispose(); scope.dispose();
  expect(scope.signal.aborted).toBe(true); expect(next).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledTimes(1);
});
it("immediately releases an asynchronously acquired resource after the page closes", async () => {
  const scope = createResourceLifetime(); const release = vi.fn(); let finish!: () => void;
  const registration = new Promise<void>(resolve => { finish = resolve; }).then(() => scope.own(release));
  scope.dispose(); finish(); await registration; expect(release).toHaveBeenCalledTimes(1);
});
