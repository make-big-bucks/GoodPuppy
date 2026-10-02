import { expect, it, vi } from "vitest";
import { createPresenterDelivery } from "./presenterDelivery.js";
it("discards a queued message invalidated while a previous send is still pending", async () => {
  let finish!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const queue = createPresenterDelivery({ controllerId: "root", send });
  let current = true;
  const first = queue.deliver("bubble-self", "panel", "history", "old snapshot", () => current);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const stale = queue.deliver("bubble-self", "panel", "message", "old room", () => current);
  current = false;
  const next = queue.deliver("bubble-self", "panel", "history", "new room", () => true);
  finish(); await Promise.all([first, stale, next]);
  expect(send.mock.calls.map(call => call[2].payload)).toEqual(["old snapshot", "new room"]);
  expect(send.mock.calls[1][2]).toMatchObject({ controllerId: "root", instanceId: "panel", sequence: 3 });
});
it("a failed send releases its queue and does not block another window instance", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined);
  const queue = createPresenterDelivery({ controllerId: "root", send });
  const failed = expect(queue.deliver("pet-a", "one", "state", 1, () => true)).rejects.toThrow("failed");
  const retry = queue.deliver("pet-a", "one", "state", 2, () => true);
  const other = queue.deliver("pet-b", "two", "state", 3, () => true);
  await Promise.all([failed, retry, other]);
  expect(send).toHaveBeenCalledTimes(3);
});
