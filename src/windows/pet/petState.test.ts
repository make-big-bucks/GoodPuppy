import { describe, it, expect } from "vitest";
import { PetAnimator } from "./petState.js";
import type { PetManifest } from "../../types";

type TimerCallback = () => void;

function makeTimers() {
  let id = 0;
  const map = new Map<number, TimerCallback>();
  return {
    set: (fn: TimerCallback, _ms: number) => {
      const nextId = ++id;
      map.set(nextId, fn);
      return nextId;
    },
    clear: (timerId: number | ReturnType<typeof setTimeout>) => {
      map.delete(timerId as number);
    },
    flushAll: () => {
      const fns = [...map.values()];
      map.clear();
      fns.forEach((fn) => fn());
    },
    pending: () => map.size,
  };
}

function makeAnimator(
  overrides: ConstructorParameters<typeof PetAnimator>[0] = {},
) {
  const states: string[] = [];
  const timers = makeTimers();
  const animator = new PetAnimator({
    petId: "shiba",
    onState: (name) => states.push(name),
    autoCycle: false,
    timers,
    ...overrides,
  });
  return { animator, timers, states, current: () => states[states.length - 1] };
}

describe("PetAnimator three-layer priority", () => {
  it("renders the base idle state on construction", () => {
    const { current } = makeAnimator();
    expect(current()).toBe("idle");
  });

  it("status layer overrides the base layer and clears back to base", () => {
    const { animator, current } = makeAnimator();
    animator.setStatus("happy");
    expect(current()).toBe("happy");
    animator.setStatus(null);
    expect(current()).toBe("idle");
  });

  it("status is a single mutually-exclusive slot (later wins)", () => {
    const { animator, current } = makeAnimator();
    animator.setStatus("busy");
    expect(current()).toBe("busy");
    animator.setStatus("happy");
    expect(current()).toBe("happy");
  });

  it("ignores non-status names passed to setStatus", () => {
    const { animator, current } = makeAnimator();
    animator.setStatus("kicked");
    expect(current()).toBe("idle");
  });

  it("transient one-shot wins over status, then expires back to status", () => {
    const { animator, timers, current } = makeAnimator();
    animator.setStatus("busy");
    animator.playTransient("kicked");
    expect(current()).toBe("kicked");
    timers.flushAll();
    expect(current()).toBe("busy");
  });

  it("held transient (drag-lift) holds until cleared", () => {
    const { animator, current } = makeAnimator();
    animator.setStatus("sad");
    animator.setHeld("drag-lift");
    expect(current()).toBe("drag-lift");
    animator.setHeld(null);
    expect(current()).toBe("sad");
  });

  it("replaying the same one-shot forces a fresh load via reload token", () => {
    const paths: string[] = [];
    const { animator, timers } = makeAnimator({ onState: (_n, p) => paths.push(p) });
    animator.playTransient("greet");
    timers.flushAll();
    animator.playTransient("greet");
    const greetPaths = paths.filter((p) => p.includes("greet.gif"));
    expect(greetPaths.length).toBe(2);
    expect(greetPaths[1]).toContain("?r=");
  });

  it("setSkin routes image paths into the skin subdir and reloads on change", () => {
    const paths: string[] = [];
    const { animator } = makeAnimator({ onState: (_n, p) => paths.push(p) });
    expect(paths[paths.length - 1]).toBe("/pets/shiba/idle.gif");
    animator.setSkin("pink");
    const last = paths[paths.length - 1];
    expect(last).toContain("/pets/shiba/skins/pink/idle.gif");
    expect(last).toContain("?r=");
  });

  it("setSkin is a no-op when the skin is unchanged", () => {
    const paths: string[] = [];
    const { animator } = makeAnimator({ onState: (_n, p) => paths.push(p) });
    const before = paths.length;
    animator.setSkin("default");
    expect(paths.length).toBe(before);
  });

  it("does not start cycle timers when autoCycle is false", () => {
    const { timers } = makeAnimator();
    expect(timers.pending()).toBe(0);
  });

  it("passes mirrored meta to onState during a mirrored transient and clears it after", () => {
    const seen: Array<{ name: string; mirrored: boolean }> = [];
    const { animator, timers } = makeAnimator({
      onState: (name, _path, meta) => seen.push({ name, mirrored: meta.mirrored }),
    });
    animator.playTransient("cuddle", { mirrored: true });
    expect(seen.at(-1)).toEqual({ name: "cuddle", mirrored: true });
    timers.flushAll();
    expect(seen.at(-1)).toEqual({ name: "idle", mirrored: false });
  });
});

describe("PetAnimator idle variants", () => {
  const variantManifest: PetManifest = {
    id: "shiba",
    skins: [],
    states: {
      idle: { durationsMs: [200, 200], loop: true },
      "idle-stretch": { durationsMs: [100, 150], loop: false, state: "idle-stretch" },
      kicked: { durationsMs: [100], loop: false, state: "kicked" },
    },
  };

  it("does not start a cycle when the manifest has no idle variants", () => {
    const { timers } = makeAnimator({ autoCycle: true });
    expect(timers.pending()).toBe(0);
  });

  it("cycles idle -> variant -> idle using manifest-declared idle-* states", () => {
    const { timers, current } = makeAnimator({
      autoCycle: true,
      manifest: variantManifest,
      random: () => 0,
    });
    expect(current()).toBe("idle");
    expect(timers.pending()).toBe(1);
    timers.flushAll();
    expect(current()).toBe("idle-stretch");
    timers.flushAll();
    expect(current()).toBe("idle");
    expect(timers.pending()).toBe(1);
  });

  it("starts cycling once setManifest injects variants", () => {
    const { animator, timers, current } = makeAnimator({ autoCycle: true, random: () => 0 });
    expect(timers.pending()).toBe(0);
    animator.setManifest(variantManifest);
    expect(timers.pending()).toBe(1);
    timers.flushAll();
    expect(current()).toBe("idle-stretch");
  });

  it("falls back to idle when the current variant disappears from a new manifest", () => {
    const { animator, timers, current } = makeAnimator({
      autoCycle: true,
      manifest: variantManifest,
      random: () => 0,
    });
    timers.flushAll();
    expect(current()).toBe("idle-stretch");
    animator.setManifest({ id: "shiba", skins: [], states: { idle: { durationsMs: [200], loop: true, state: "idle" } } });
    expect(current()).toBe("idle");
    expect(timers.pending()).toBe(0);
  });

  it("constructs with the real default timers (autoCycle) without throwing", () => {
    const states: string[] = [];
    expect(
      () => new PetAnimator({ petId: "shiba", autoCycle: true, onState: (n) => states.push(n) }),
    ).not.toThrow();
    expect(states[states.length - 1]).toBe("idle");
  });
});
