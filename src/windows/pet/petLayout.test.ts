import { describe, expect, it } from "vitest";
import {
  getPetWindowSize,
  getBubbleWindowSize,
  orderRemotePetIds,
  clampPetScale,
  stepPetScale,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
  DEFAULT_PET_SCALE,
  BUBBLE_STACK_SPACE,
  computeBubbleWindowPosition,
  isWindowPositionVisible,
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

describe("isWindowPositionVisible", () => {
  const size = { width: 150, height: 120 };
  const laptop = { x: 0, y: 0, width: 1512, height: 982 };
  const external = { x: 1512, y: 0, width: 1920, height: 1080 };

  it("accepts a position fully inside a screen", () => {
    expect(isWindowPositionVisible({ x: 100, y: 100 }, size, [laptop])).toBe(true);
  });

  it("rejects a stored position on a now-disconnected external monitor", () => {
    // 真实复现：存档 {x:1588} 来自外接屏，断开后只剩 1512 宽的主屏。
    expect(isWindowPositionVisible({ x: 1588, y: 421 }, size, [laptop])).toBe(false);
  });

  it("accepts that same position when the external monitor is still connected", () => {
    expect(isWindowPositionVisible({ x: 1588, y: 421 }, size, [laptop, external])).toBe(true);
  });

  it("accepts a position that still shows at least a 48px corner", () => {
    // 窗口右侧大部分出屏，但左侧仍露出 60px 宽、120px 高。
    expect(isWindowPositionVisible({ x: 1452, y: 100 }, size, [laptop])).toBe(true);
  });

  it("rejects a position showing only a sliver thinner than minVisible", () => {
    // 仅露出 10px 宽。
    expect(isWindowPositionVisible({ x: 1502, y: 100 }, size, [laptop])).toBe(false);
  });

  it("returns true when screen info is unavailable (never punish on missing data)", () => {
    expect(isWindowPositionVisible({ x: 99999, y: 99999 }, size, [])).toBe(true);
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

describe("getBubbleWindowSize", () => {
  it("matches pet width (centers over the pet) and reserves the stack height", () => {
    expect(getBubbleWindowSize()).toEqual({ width: 150, height: BUBBLE_STACK_SPACE });
  });

  it("scales with the pet scale", () => {
    expect(getBubbleWindowSize(2)).toEqual({ width: 300, height: BUBBLE_STACK_SPACE * 2 });
  });
});

describe("computeBubbleWindowPosition", () => {
  const bubble = { width: 150, height: 180 };
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };

  it("places the bubble above the pet by default, centered over it", () => {
    const pet = { x: 700, y: 500, width: 150, height: 120 };
    const r = computeBubbleWindowPosition({ pet, bubble, workArea });
    expect(r.placement).toBe("above");
    expect(r.y).toBe(500 - 180); // bubble bottom meets pet top
    expect(r.x).toBe(700); // same width → centered = same x
  });

  it("flips below when there is not enough room above (pet near the top)", () => {
    const pet = { x: 700, y: 120, width: 150, height: 120 };
    const r = computeBubbleWindowPosition({ pet, bubble, workArea });
    expect(r.placement).toBe("below");
    expect(r.y).toBe(120 + 120); // bubble top meets pet bottom
  });

  it("centers a wider/narrower bubble over the pet", () => {
    const pet = { x: 700, y: 500, width: 150, height: 120 };
    const r = computeBubbleWindowPosition({ pet, bubble: { width: 100, height: 180 }, workArea });
    expect(r.x).toBe(700 + (150 - 100) / 2);
  });

  it("clamps the bubble horizontally into the work area", () => {
    const nearLeft = computeBubbleWindowPosition({
      pet: { x: -20, y: 500, width: 150, height: 120 },
      bubble,
      workArea,
    });
    expect(nearLeft.x).toBe(0); // clamped to work-area left
    const nearRight = computeBubbleWindowPosition({
      pet: { x: 1400, y: 500, width: 150, height: 120 },
      bubble,
      workArea,
    });
    expect(nearRight.x).toBe(1440 - 150); // clamped to work-area right
  });

  it("respects a non-zero work-area top when deciding the flip", () => {
    const pet = { x: 700, y: 200, width: 150, height: 120 };
    // above would be y=20, which is below a menu-bar top of 25 → flip below.
    const r = computeBubbleWindowPosition({ pet, bubble, workArea: { x: 0, y: 25, width: 1440, height: 875 } });
    expect(r.placement).toBe("below");
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
