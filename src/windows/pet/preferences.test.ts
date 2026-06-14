import { describe, expect, it } from "vitest";
import {
  readStoredSkin,
  writeStoredSkin,
  readStoredScale,
  writeStoredScale,
  SKIN_STORAGE_KEY,
  SCALE_STORAGE_KEY,
} from "./preferences.js";
import { DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, DEFAULT_PET_SCALE, MAX_PET_SCALE } from "./petLayout.js";

type TestStorage = Pick<Storage, "getItem" | "setItem">;

function fakeStorage(initial: Record<string, string> = {}): TestStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

function throwingStorage(): TestStorage {
  return {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
}

describe("readStoredSkin", () => {
  it("returns the stored skin when present", () => {
    const storage = fakeStorage({ [SKIN_STORAGE_KEY]: "cocoa" });
    expect(readStoredSkin(storage)).toBe("cocoa");
  });

  it("falls back to the default skin when missing or storage throws", () => {
    expect(readStoredSkin(fakeStorage())).toBe(DEFAULT_SKIN);
    expect(readStoredSkin(throwingStorage())).toBe(DEFAULT_SKIN);
  });
});

describe("writeStoredSkin", () => {
  it("persists the skin under the skin key", () => {
    const storage = fakeStorage();
    writeStoredSkin("cocoa", storage);
    expect(storage.getItem(SKIN_STORAGE_KEY)).toBe("cocoa");
  });

  it("swallows storage errors without throwing", () => {
    expect(() => writeStoredSkin("cocoa", throwingStorage())).not.toThrow();
  });
});

describe("readStoredScale", () => {
  it("returns the default scale when nothing is stored", () => {
    expect(readStoredScale(fakeStorage())).toBe(DEFAULT_PET_SCALE);
  });

  it("clamps an out-of-range stored value into the allowed range", () => {
    const storage = fakeStorage({ [SCALE_STORAGE_KEY]: "999" });
    expect(readStoredScale(storage)).toBe(clampPetScale(999));
    expect(readStoredScale(storage)).toBe(MAX_PET_SCALE);
  });

  it("falls back to the default scale when storage throws", () => {
    expect(readStoredScale(throwingStorage())).toBe(DEFAULT_PET_SCALE);
  });
});

describe("writeStoredScale", () => {
  it("persists the scale as a string under the scale key", () => {
    const storage = fakeStorage();
    writeStoredScale(1.25, storage);
    expect(storage.getItem(SCALE_STORAGE_KEY)).toBe("1.25");
  });

  it("swallows storage errors without throwing", () => {
    expect(() => writeStoredScale(1.25, throwingStorage())).not.toThrow();
  });
});
