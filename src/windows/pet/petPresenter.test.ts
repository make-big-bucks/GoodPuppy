import { afterEach, describe, expect, it, vi } from "vitest";
import { createPetPresenter } from "./petPresenter.js";
vi.mock("./hitTesting.js", () => ({ isPointOpaqueInImage: () => true, buildAlphaMask: () => null }));
vi.mock("./renderImage.js", () => ({ applyStateToImage: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("presenter resource ownership", () => {
  it("stops hidden work, resumes once and disposes all callbacks and timers", () => {
    vi.useFakeTimers();
    const release = vi.fn(); const frame = vi.fn(() => 42); const cancel = vi.fn();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => ({ getContext: () => null }) });
    const win = Object.assign(new EventTarget(), { requestAnimationFrame: frame, goodPuppy: {
      supportsNativeWindowDrag: () => true, onDragEnded: () => release, publishHitShape: vi.fn(),
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
