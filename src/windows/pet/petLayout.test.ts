import { describe, expect, it } from "vitest";
import {
  getPetWindowLayout,
  orderRemotePetIds,
  clampPetScale,
  stepPetScale,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
  DEFAULT_PET_SCALE,
  PET_WINDOW_HEIGHT,
  BUBBLE_STACK_SPACE,
  getBubbleWindowLayout,
  computeWindowTop,
  petAnchorBottomY,
  shouldFlipStack,
} from "./petLayout.js";

describe("orderRemotePetIds", () => {
  it("deduplicates and sorts remote pet ids for stable DOM layout", () => {
    expect(orderRemotePetIds(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("getPetWindowLayout", () => {
  it("keeps the base one-pet window size when no remote pets are online", () => {
    expect(getPetWindowLayout(0)).toEqual({ width: 150, height: 120 });
  });

  it("widens the single transparent window as remote pets join", () => {
    expect(getPetWindowLayout(1)).toEqual({ width: 270, height: 120 });
    expect(getPetWindowLayout(2)).toEqual({ width: 390, height: 120 });
  });

  it("scales window dimensions by the user-chosen pet scale", () => {
    expect(getPetWindowLayout(0, 2)).toEqual({ width: 300, height: 240 });
    expect(getPetWindowLayout(0, 0.6)).toEqual({ width: 90, height: 72 });
    expect(getPetWindowLayout(1, 1.5)).toEqual({ width: 405, height: 180 });
  });

  it("clamps out-of-range scales before applying to the window", () => {
    expect(getPetWindowLayout(0, 99)).toEqual(getPetWindowLayout(0, MAX_PET_SCALE));
    expect(getPetWindowLayout(0, 0)).toEqual(getPetWindowLayout(0, DEFAULT_PET_SCALE));
  });
});

describe("clampPetScale", () => {
  it("keeps values inside the allowed range", () => {
    expect(clampPetScale(1)).toBe(1);
    expect(clampPetScale(MIN_PET_SCALE)).toBe(MIN_PET_SCALE);
    expect(clampPetScale(MAX_PET_SCALE)).toBe(MAX_PET_SCALE);
  });

  it("clamps below min and above max to the bounds", () => {
    expect(clampPetScale(0.1)).toBe(MIN_PET_SCALE);
    expect(clampPetScale(5)).toBe(MAX_PET_SCALE);
  });

  it("falls back to the default for non-numeric input", () => {
    expect(clampPetScale("abc")).toBe(DEFAULT_PET_SCALE);
    expect(clampPetScale(NaN)).toBe(DEFAULT_PET_SCALE);
    expect(clampPetScale(null)).toBe(DEFAULT_PET_SCALE);
  });

  it("rounds to two decimals to avoid float drift", () => {
    expect(clampPetScale(1.2000000001)).toBe(1.2);
  });
});

describe("getBubbleWindowLayout", () => {
  it("keeps pet-only height when there are no visible bubbles", () => {
    const layout = getBubbleWindowLayout({ remotePetCount: 0, scale: 1, hasBubbles: false, flipped: false });
    expect(layout).toEqual({ width: 150, height: 120, belowWin: 0, aboveWin: 0 });
  });

  it("grows upward by the stack space when bubbles are shown", () => {
    const layout = getBubbleWindowLayout({ remotePetCount: 0, scale: 1, hasBubbles: true, flipped: false });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT + BUBBLE_STACK_SPACE);
    expect(layout.aboveWin).toBe(BUBBLE_STACK_SPACE);
    expect(layout.belowWin).toBe(0);
  });

  it("reserves the stack space below the pet when flipped", () => {
    const layout = getBubbleWindowLayout({ remotePetCount: 0, scale: 1, hasBubbles: true, flipped: true });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT + BUBBLE_STACK_SPACE);
    expect(layout.belowWin).toBe(BUBBLE_STACK_SPACE);
    expect(layout.aboveWin).toBe(0);
  });

  it("scales the stack space with the pet scale", () => {
    const layout = getBubbleWindowLayout({ remotePetCount: 0, scale: 2, hasBubbles: true, flipped: false });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT * 2 + BUBBLE_STACK_SPACE * 2);
  });
});

describe("computeWindowTop / petAnchorBottomY", () => {
  it("keeps the pet anchor fixed when growing upward (round-trips)", () => {
    // Start: no bubbles, window top 500, height PET_WINDOW_HEIGHT, belowWin 0 → anchor 620.
    const anchor = petAnchorBottomY(500, { height: PET_WINDOW_HEIGHT, belowWin: 0 });
    expect(anchor).toBe(500 + PET_WINDOW_HEIGHT);
    // Grow upward: window moves up by the stack space, bottom stays put.
    const grown = getBubbleWindowLayout({ remotePetCount: 0, scale: 1, hasBubbles: true, flipped: false });
    expect(computeWindowTop(anchor, grown)).toBe(500 - BUBBLE_STACK_SPACE);
  });

  it("keeps the window top fixed when flipping (space added below)", () => {
    const anchor = petAnchorBottomY(500, { height: PET_WINDOW_HEIGHT, belowWin: 0 });
    const flipped = getBubbleWindowLayout({ remotePetCount: 0, scale: 1, hasBubbles: true, flipped: true });
    expect(computeWindowTop(anchor, flipped)).toBe(500);
  });
});

describe("shouldFlipStack", () => {
  it("flips when growing upward would cross the work-area top", () => {
    // anchor near the top: 200, scale 1 → not-flipped top = 200 - 400 = -200 < 0.
    expect(shouldFlipStack({ anchorBottomY: 200, scale: 1, workAreaTop: 0 })).toBe(true);
  });

  it("does not flip when there is room above", () => {
    expect(shouldFlipStack({ anchorBottomY: 900, scale: 1, workAreaTop: 0 })).toBe(false);
  });
});

describe("stepPetScale", () => {
  it("steps up and down by the fixed step", () => {
    expect(stepPetScale(1, 1)).toBe(1.2);
    expect(stepPetScale(1, -1)).toBe(0.8);
  });

  it("never steps past the bounds", () => {
    expect(stepPetScale(MAX_PET_SCALE, 1)).toBe(MAX_PET_SCALE);
    expect(stepPetScale(MIN_PET_SCALE, -1)).toBe(MIN_PET_SCALE);
  });
});
