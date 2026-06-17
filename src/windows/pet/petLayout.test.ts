import { describe, expect, it } from "vitest";
import {
  getPetWindowSize,
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

describe("getPetWindowSize", () => {
  it("keeps the base one-pet window size (no horizontal widening per member)", () => {
    expect(getPetWindowSize()).toEqual({ width: 150, height: 120 });
  });

  it("scales window dimensions by the user-chosen pet scale", () => {
    expect(getPetWindowSize(2)).toEqual({ width: 300, height: 240 });
    expect(getPetWindowSize(0.6)).toEqual({ width: 90, height: 72 });
  });

  it("clamps out-of-range scales before applying to the window", () => {
    expect(getPetWindowSize(99)).toEqual(getPetWindowSize(MAX_PET_SCALE));
    expect(getPetWindowSize(0)).toEqual(getPetWindowSize(DEFAULT_PET_SCALE));
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
    const layout = getBubbleWindowLayout({ scale: 1, hasBubbles: false, flipped: false });
    expect(layout).toEqual({ width: 150, height: 120, belowWin: 0, aboveWin: 0 });
  });

  it("grows upward by the stack space when bubbles are shown", () => {
    const layout = getBubbleWindowLayout({ scale: 1, hasBubbles: true, flipped: false });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT + BUBBLE_STACK_SPACE);
    expect(layout.aboveWin).toBe(BUBBLE_STACK_SPACE);
    expect(layout.belowWin).toBe(0);
  });

  it("reserves the stack space below the pet when flipped", () => {
    const layout = getBubbleWindowLayout({ scale: 1, hasBubbles: true, flipped: true });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT + BUBBLE_STACK_SPACE);
    expect(layout.belowWin).toBe(BUBBLE_STACK_SPACE);
    expect(layout.aboveWin).toBe(0);
  });

  it("scales the stack space with the pet scale", () => {
    const layout = getBubbleWindowLayout({ scale: 2, hasBubbles: true, flipped: false });
    expect(layout.height).toBe(PET_WINDOW_HEIGHT * 2 + BUBBLE_STACK_SPACE * 2);
  });
});

describe("computeWindowTop / petAnchorBottomY", () => {
  it("keeps the pet anchor fixed when growing upward (round-trips)", () => {
    // Start: no bubbles, window top 500, height PET_WINDOW_HEIGHT, belowWin 0 → anchor 620.
    const anchor = petAnchorBottomY(500, { height: PET_WINDOW_HEIGHT, belowWin: 0 });
    expect(anchor).toBe(500 + PET_WINDOW_HEIGHT);
    // Grow upward: window moves up by the stack space, bottom stays put.
    const grown = getBubbleWindowLayout({ scale: 1, hasBubbles: true, flipped: false });
    expect(computeWindowTop(anchor, grown)).toBe(500 - BUBBLE_STACK_SPACE);
  });

  it("keeps the window top fixed when flipping (space added below)", () => {
    const anchor = petAnchorBottomY(500, { height: PET_WINDOW_HEIGHT, belowWin: 0 });
    const flipped = getBubbleWindowLayout({ scale: 1, hasBubbles: true, flipped: true });
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
