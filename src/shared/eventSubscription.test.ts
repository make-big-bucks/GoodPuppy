import { describe, expect, it, vi } from "vitest";
import { createEventSubscription } from "./eventSubscription.js";
describe("asynchronous event registration", () => {
  it("disposes late registration exactly once and suppresses callbacks", async () => {
    let registered!: (dispose: () => void) => void;
    let emit!: (value: string) => void;
    const callback = vi.fn();
    const release = vi.fn();
    const subscription = createEventSubscription<string>((handler) => { emit = handler; return new Promise((resolve) => { registered = resolve; }); }, callback);
    await Promise.resolve();
    subscription();
    registered(release);
    await subscription.ready;
    emit("late");
    subscription();
    expect(release).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });
});
