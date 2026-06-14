import { describe, expect, it } from "vitest";
import { createIgnoreMouseEventsController } from "./cursorEventsController.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createIgnoreMouseEventsController", () => {
  it("serializes native cursor ignore changes and applies the latest requested state", async () => {
    const pendingCalls = [];
    const calls = [];
    const controller = createIgnoreMouseEventsController({
      setIgnoreCursorEvents(value) {
        const pending = deferred();
        calls.push(value);
        pendingCalls.push(pending);
        return pending.promise;
      }
    });

    controller.setIgnoreMouseEvents(true);
    controller.setIgnoreMouseEvents(false);

    expect(calls).toEqual([true]);

    pendingCalls.shift().resolve();
    await flushMicrotasks();

    expect(calls).toEqual([true, false]);
  });

  it("coalesces duplicate requests while a native cursor ignore change is in flight", async () => {
    const pendingCalls = [];
    const calls = [];
    const controller = createIgnoreMouseEventsController({
      setIgnoreCursorEvents(value) {
        const pending = deferred();
        calls.push(value);
        pendingCalls.push(pending);
        return pending.promise;
      }
    });

    controller.setIgnoreMouseEvents(true);
    controller.setIgnoreMouseEvents(true);

    expect(calls).toEqual([true]);

    pendingCalls.shift().resolve();
    await flushMicrotasks();

    expect(calls).toEqual([true]);
  });

  it("retries the latest requested state after a native cursor ignore change fails", async () => {
    const calls = [];
    const errors = [];
    const controller = createIgnoreMouseEventsController(
      {
        setIgnoreCursorEvents(value) {
          calls.push(value);

          if (calls.length === 1) {
            return Promise.reject(new Error("native failure"));
          }

          return Promise.resolve();
        }
      },
      { onError: (error) => errors.push(error) }
    );

    controller.setIgnoreMouseEvents(true);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(calls).toEqual([true, true]);
    expect(errors).toHaveLength(1);
  });
});
