import { describe, expect, it } from "vitest";
import { computeSemiFreeLayout, resolveRemoteLayout, PET_ROW_GAP } from "./petAutoLayout.js";

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

it("converts remote logical footprints and gaps to the target desktop plane", () => {
  const layout = computeSemiFreeLayout({ selfPos: { x: 100, y: 100 }, selfSize: { width: 150, height: 120 },
    remoteIds: ["a", "b"], petWindowWidth: 150, petWindowHeight: 120, scaleAt: () => 2 });
  expect(layout.get("a")).toEqual({ x: 274, y: -20 });
  expect(layout.get("b")).toEqual({ x: 598, y: -20 });
});

it("chooses scale at the final horizontal slot when a DPI change lies inside the gap", () => {
  const layout = computeSemiFreeLayout({ selfPos: { x: 100, y: 100 }, selfSize: { width: 20, height: 120 },
    remoteIds: ["a", "b"], petWindowWidth: 150, petWindowHeight: 120, scaleAt: point => point.x < 140 ? 2 : 1 });
  expect(layout.get("a")).toEqual({ x: 144, y: 100 });
  expect(layout.get("b")).toEqual({ x: 306, y: 100 });
});

it("uses visible saved positions in free mode and reports off-screen positions for deferred cleanup", () => {
  const stored = new Map([["a", { x: 20, y: 30 }], ["b", { x: 4000, y: 30 }]]);
  const opts = { selfPos: { x: 100, y: 100 }, selfSize: { width: 150, height: 120 }, remoteIds: ["a", "b"],
    petSize: { width: 150, height: 120 }, monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }], stored };
  const free = resolveRemoteLayout({ ...opts, free: true });
  expect(free.layout.get("a")).toEqual(stored.get("a")); expect(free.invalidStored).toEqual(["b"]);
  expect(stored.has("b")).toBe(true);
  const semi = resolveRemoteLayout({ ...opts, free: false });
  expect(semi.layout.get("a")).toEqual({ x: 262, y: 100 }); expect(semi.invalidStored).toEqual([]);
});
