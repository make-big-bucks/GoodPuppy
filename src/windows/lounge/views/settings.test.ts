import { describe, it, expect } from "vitest";
import { scaleToPercent } from "./settings.js";
import { DEFAULT_PET_SCALE, MIN_PET_SCALE, MAX_PET_SCALE } from "../../../shared/pet/petLayout.js";

describe("scaleToPercent", () => {
  it("renders the default scale as 100%", () => {
    expect(scaleToPercent(DEFAULT_PET_SCALE)).toBe("100%");
  });

  it("rounds intermediate scales to whole percent", () => {
    expect(scaleToPercent(1.25)).toBe("125%");
    expect(scaleToPercent(0.833)).toBe("83%");
  });

  it("clamps out-of-range scales before formatting", () => {
    expect(scaleToPercent(MIN_PET_SCALE - 0.5)).toBe(`${Math.round(MIN_PET_SCALE * 100)}%`);
    expect(scaleToPercent(MAX_PET_SCALE + 1)).toBe(`${Math.round(MAX_PET_SCALE * 100)}%`);
  });
});
