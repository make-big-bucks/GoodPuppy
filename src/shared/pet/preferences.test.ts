import { describe, expect, it } from "vitest";
import {
  readStoredScale,
  writeStoredScale,
  readStoredMode,
  writeStoredMode,
  SCALE_STORAGE_KEY,
  PET_MODE_STORAGE_KEY,
  DEFAULT_PET_MODE,
} from "./preferences.js";
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

describe("readStoredMode", () => {
  it("defaults to free when nothing is stored", () => {
    expect(readStoredMode(fakeStorage())).toBe(DEFAULT_PET_MODE);
    expect(DEFAULT_PET_MODE).toBe("free");
  });

  it("returns a valid stored mode", () => {
    expect(readStoredMode(fakeStorage({ [PET_MODE_STORAGE_KEY]: "semi" }))).toBe("semi");
    expect(readStoredMode(fakeStorage({ [PET_MODE_STORAGE_KEY]: "free" }))).toBe("free");
  });

  it("falls back to default for unknown values or storage errors", () => {
    expect(readStoredMode(fakeStorage({ [PET_MODE_STORAGE_KEY]: "bogus" }))).toBe(DEFAULT_PET_MODE);
    expect(readStoredMode(throwingStorage())).toBe(DEFAULT_PET_MODE);
  });
});

describe("writeStoredMode", () => {
  it("persists the mode under the mode key", () => {
    const storage = fakeStorage();
    writeStoredMode("semi", storage);
    expect(storage.getItem(PET_MODE_STORAGE_KEY)).toBe("semi");
  });

  it("swallows storage errors without throwing", () => {
    expect(() => writeStoredMode("semi", throwingStorage())).not.toThrow();
  });
});
