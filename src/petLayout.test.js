import { describe, expect, it } from "vitest";
import { getPetWindowLayout, orderRemotePetIds } from "./petLayout.js";

describe("orderRemotePetIds", () => {
  it("deduplicates and sorts remote pet ids for stable DOM layout", () => {
    expect(orderRemotePetIds(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("getPetWindowLayout", () => {
  it("keeps the original one-pet window size when no remote pets are online", () => {
    expect(getPetWindowLayout(0)).toEqual({ width: 260, height: 360 });
  });

  it("widens the single transparent window as remote pets join", () => {
    expect(getPetWindowLayout(1)).toEqual({ width: 480, height: 360 });
    expect(getPetWindowLayout(2)).toEqual({ width: 700, height: 360 });
  });
});
