import { afterEach, describe, expect, it, vi } from "vitest";
import { createPetPresenter } from "./petPresenter.js";
vi.mock("./hitTesting.js", () => ({ isPointInAlphaMask: () => true, buildAlphaMask: () => null }));
vi.mock("./renderImage.js", () => ({ applyStateToImage: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("presenter resource ownership", () => {
  it("retries a failed shape publication and skips unchanged successful shapes", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    let draw!: () => void;
    const publish = vi.fn().mockRejectedValueOnce(new Error("IPC failed")).mockResolvedValue(undefined);
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => ({ getContext: () => null }) });
    const win = Object.assign(new EventTarget(), { requestAnimationFrame: (callback: () => void) => { draw = callback; return 1; }, goodPuppy: {
      supportsNativeWindowDrag: () => true, onDragEnded: () => () => {}, publishHitShape: publish,
    } });
    vi.stubGlobal("document", doc); vi.stubGlobal("window", win); vi.stubGlobal("cancelAnimationFrame", () => {});
    const presenter = createPetPresenter({ stage: Object.assign(new EventTarget(), { classList: { contains: () => false } }) as never,
      petImage: new EventTarget() as never, animator: { pause() {}, resume() {}, destroy() {}, onState: () => {} } as never,
      isDraggable: () => true, onShowContextMenu: () => {} });
    draw(); await vi.advanceTimersByTimeAsync(120); draw(); await vi.advanceTimersByTimeAsync(120); draw();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    presenter.dispose(); vi.restoreAllMocks();
  });
  it("releases manual dragging after a position write rejects", async () => {
    vi.useFakeTimers(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    class ElementStub extends EventTarget { closest() { return this; } }
    vi.stubGlobal("Element", ElementStub);
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => ({ getContext: () => null }) });
    const position = vi.fn().mockRejectedValue(new Error("position denied"));
    const win = Object.assign(new EventTarget(), { requestAnimationFrame: () => 42, goodPuppy: {
      supportsNativeWindowDrag: () => false, onDragEnded: () => () => {}, publishHitShape: vi.fn(async () => {}),
      getWindowPosition: async () => ({ x: 10, y: 20 }), setWindowPosition: position,
    } });
    vi.stubGlobal("document", doc); vi.stubGlobal("window", win); vi.stubGlobal("cancelAnimationFrame", () => {});
    const release = vi.fn();
    const stage = Object.assign(new ElementStub(), { classList: { contains: () => false },
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: release });
    const animator = { pause() {}, resume() {}, destroy() {}, setHeld: vi.fn(), onState: () => {} };
    const presenter = createPetPresenter({ stage: stage as never, petImage: new EventTarget() as never,
      animator: animator as never, isDraggable: () => true, onShowContextMenu: () => {} });
    const event = (type: string, x: number) => Object.assign(new Event(type), { button: 0, pointerId: 1, screenX: x, screenY: 0 });
    stage.dispatchEvent(event("pointerdown", 100)); await Promise.resolve();
    stage.dispatchEvent(event("pointermove", 110)); await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveBeenCalledWith(1); expect(animator.setHeld).toHaveBeenLastCalledWith(null);
    stage.dispatchEvent(event("pointermove", 120)); expect(position).toHaveBeenCalledTimes(1);
    presenter.dispose(); log.mockRestore();
  });
  it("stops hidden work, resumes once and disposes all callbacks and timers", () => {
    vi.useFakeTimers();
    const release = vi.fn(); const frame = vi.fn(() => 42); const cancel = vi.fn();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => ({ getContext: () => null }) });
    const win = Object.assign(new EventTarget(), { requestAnimationFrame: frame, goodPuppy: {
      supportsNativeWindowDrag: () => true, onDragEnded: () => release, publishHitShape: vi.fn(async () => {}),
    } });
    vi.stubGlobal("document", doc); vi.stubGlobal("window", win); vi.stubGlobal("cancelAnimationFrame", cancel);
    const animator = { pause: vi.fn(), resume: vi.fn(), destroy: vi.fn(), setHeld: vi.fn(), onState: () => {} };
    const stage = Object.assign(new EventTarget(), { classList: { contains: () => false } });
    const presenter = createPetPresenter({ stage: stage as never, petImage: new EventTarget() as never,
      animator: animator as never, isDraggable: () => true, onShowContextMenu: () => {} });
    expect(vi.getTimerCount()).toBe(1);
    presenter.setVisible(false); expect(vi.getTimerCount()).toBe(0); expect(cancel).toHaveBeenCalledWith(42);
    presenter.setVisible(true); presenter.setVisible(true); expect(vi.getTimerCount()).toBe(1);
    presenter.dispose(); presenter.dispose();
    expect(vi.getTimerCount()).toBe(0); expect(release).toHaveBeenCalledTimes(1); expect(animator.destroy).toHaveBeenCalledTimes(1);
    const calls = frame.mock.calls.length;
    win.dispatchEvent(new Event("resize")); doc.dispatchEvent(new Event("visibilitychange"));
    presenter.refreshPassthrough(); presenter.setVisible(true);
    expect(frame).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
});
