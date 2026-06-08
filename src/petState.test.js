import { describe, it, expect } from "vitest";
import { getSafeState } from "./petState.js";

describe("getSafeState", () => {
  it("returns the state when it is a valid integer in [1,24]", () => {
    expect(getSafeState(5)).toBe(5);
    expect(getSafeState(1)).toBe(1);
    expect(getSafeState(24)).toBe(24);
  });

  it("returns the fallback for out-of-range or non-integer input", () => {
    expect(getSafeState(0)).toBe(3);
    expect(getSafeState(25)).toBe(3);
    expect(getSafeState(NaN)).toBe(3);
    expect(getSafeState(2.5)).toBe(3);
  });

  it("honors a custom fallback", () => {
    expect(getSafeState(99, 6)).toBe(6);
  });
});
