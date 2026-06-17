import { describe, expect, it } from "vitest";
import { computeSemiFreeLayout, PET_ROW_GAP } from "./petAutoLayout.js";

describe("computeSemiFreeLayout", () => {
  const base = {
    selfPos: { x: 500, y: 400 },
    selfSize: { width: 150, height: 120 },
    petWindowWidth: 150,
    petWindowHeight: 120,
  };

  it("places remotes in a row to the right of the self window, bottoms aligned", () => {
    const layout = computeSemiFreeLayout({ ...base, remoteIds: ["a", "b"] });
    const startX = 500 + 150 + PET_ROW_GAP;
    expect(layout.get("a")).toEqual({ x: startX, y: 400 + 120 - 120 });
    expect(layout.get("b")).toEqual({ x: startX + (150 + PET_ROW_GAP), y: 400 });
  });

  it("aligns window bottoms when remote pets are a different height", () => {
    const layout = computeSemiFreeLayout({ ...base, remoteIds: ["a"], petWindowHeight: 200 });
    // bottom = 520; y = 520 - 200 = 320
    expect(layout.get("a")).toEqual({ x: 500 + 150 + PET_ROW_GAP, y: 320 });
  });

  it("returns an empty map when there are no remotes", () => {
    expect(computeSemiFreeLayout({ ...base, remoteIds: [] }).size).toBe(0);
  });
});
