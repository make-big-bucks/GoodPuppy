import { describe, expect, it } from "vitest";
import {
  getPetWindowLayout,
  orderRemotePetIds,
  clampPetScale,
  stepPetScale,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
  DEFAULT_PET_SCALE,
} from "./petLayout.js";

describe("orderRemotePetIds", () => {
  it("deduplicates and sorts remote pet ids for stable DOM layout", () => {
    expect(orderRemotePetIds(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("getPetWindowLayout", () => {
  it("keeps the base one-pet window size when no remote pets are online", () => {
    expect(getPetWindowLayout(0)).toEqual({ width: 150, height: 220 });
  });

  it("widens the single transparent window as remote pets join", () => {
    expect(getPetWindowLayout(1)).toEqual({ width: 270, height: 220 });
    expect(getPetWindowLayout(2)).toEqual({ width: 390, height: 220 });
  });

  it("scales window dimensions by the user-chosen pet scale", () => {
    expect(getPetWindowLayout(0, 2)).toEqual({ width: 300, height: 440 });
    expect(getPetWindowLayout(0, 0.6)).toEqual({ width: 90, height: 132 });
    expect(getPetWindowLayout(1, 1.5)).toEqual({ width: 405, height: 330 });
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
