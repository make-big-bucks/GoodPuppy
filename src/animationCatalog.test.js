import { describe, it, expect } from "vitest";
import {
  resolvePetDir,
  getStateImagePath,
  isStatusState,
  isIdleVariant,
  getBehavior,
  LAYER,
  durationFromManifest,
  DEFAULT_ONESHOT_MS,
  DEFAULT_SKIN,
  INTERACTIONS,
  STATUS_OPTIONS,
} from "./animationCatalog.js";

describe("resolvePetDir", () => {
  it("maps default to shiba and passes through known pets", () => {
    expect(resolvePetDir("default")).toBe("shiba");
    expect(resolvePetDir("shiba")).toBe("shiba");
  });

  it("falls back to shiba for unknown pets", () => {
    expect(resolvePetDir("unknown-pet")).toBe("shiba");
  });
});

describe("getStateImagePath", () => {
  it("builds a semantic path under the resolved pet dir", () => {
    expect(getStateImagePath("default", "idle")).toBe("/pets/shiba/idle.gif");
    expect(getStateImagePath("shiba", "kicked")).toBe("/pets/shiba/kicked.gif");
  });

  it("keeps the base path for the default skin", () => {
    expect(getStateImagePath("shiba", "idle", DEFAULT_SKIN)).toBe("/pets/shiba/idle.gif");
    expect(getStateImagePath("shiba", "idle", undefined)).toBe("/pets/shiba/idle.gif");
  });

  it("routes non-default skins into the skins subdir", () => {
    expect(getStateImagePath("shiba", "idle", "pink")).toBe("/pets/shiba/skins/pink/idle.gif");
    expect(getStateImagePath("default", "feed", "blue")).toBe("/pets/shiba/skins/blue/feed.gif");
  });
});

describe("isStatusState", () => {
  it("recognizes persistent status states only", () => {
    expect(isStatusState("happy")).toBe(true);
    expect(isStatusState("busy")).toBe(true);
    expect(isStatusState("idle")).toBe(false);
    expect(isStatusState("kicked")).toBe(false);
  });
});

describe("durationFromManifest", () => {
  it("sums per-frame durations", () => {
    expect(durationFromManifest({ durationsMs: [100, 200, 50] })).toBe(350);
  });

  it("falls back when manifest is missing or empty", () => {
    expect(durationFromManifest(null)).toBe(DEFAULT_ONESHOT_MS);
    expect(durationFromManifest({ durationsMs: [] })).toBe(DEFAULT_ONESHOT_MS);
  });
});

describe("INTERACTIONS routing", () => {
  it("routes both roles: actor casts for kick/feed, targets play the effect", () => {
    expect(INTERACTIONS.kick).toMatchObject({ actorState: "cast", targetState: "kicked" });
    expect(INTERACTIONS.feed).toMatchObject({ actorState: "cast", targetState: "feed" });
  });

  it("cuddle plays on both sides with facing mirror and a hold duration", () => {
    expect(INTERACTIONS.cuddle).toMatchObject({
      actorState: "cuddle",
      targetState: "cuddle",
      mirror: "facing",
    });
    expect(INTERACTIONS.cuddle.holdMs).toBeGreaterThan(0);
  });
});

describe("idle variants", () => {
  it("recognizes idle-* names as variants", () => {
    expect(isIdleVariant("idle-stretch")).toBe(true);
    expect(isIdleVariant("idle-tail-chase")).toBe(true);
    expect(isIdleVariant("idle")).toBe(false);
    expect(isIdleVariant("wander")).toBe(false);
  });

  it("getBehavior falls back to a base-layer variant behavior for idle-* names", () => {
    expect(getBehavior("idle-stretch")).toEqual({ layer: LAYER.BASE, kind: "variant" });
    expect(getBehavior("idle")).toMatchObject({ kind: "base" });
    expect(getBehavior("not-a-state")).toBeNull();
  });
});

describe("STATUS_OPTIONS", () => {
  it("covers both mood and work groups", () => {
    const groups = new Set(STATUS_OPTIONS.map((o) => o.group));
    expect(groups).toEqual(new Set(["mood", "work"]));
  });
});
