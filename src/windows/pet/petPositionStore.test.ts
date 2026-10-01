import { describe, expect, it, vi } from "vitest";
import {
  readRemotePos,
  readSelfPos,
  remotePosKey,
  writeRemotePos,
  writeSelfPos,
} from "./petPositionStore.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

describe("petPositionStore", () => {
  it("derives the per-room+member key", () => {
    expect(remotePosKey("room-1", "user-9")).toBe("pet-pos:room-1:user-9");
  });

  it("round-trips the self position globally", () => {
    const storage = fakeStorage();
    expect(readSelfPos(storage)).toBeNull();
    writeSelfPos({ x: 42.6, y: -10.2 }, storage);
    expect(readSelfPos(storage)).toEqual({ x: 43, y: -10 });
    expect(storage._map.get("pet-pos:self")).toBe('{"space":"desktop-logical-v2","x":43,"y":-10}');
  });

  it("round-trips a remote position per room+member", () => {
    const storage = fakeStorage();
    expect(readRemotePos("r", "u", storage)).toBeNull();
    writeRemotePos("r", "u", { x: 100, y: 200 }, storage);
    expect(readRemotePos("r", "u", storage)).toEqual({ x: 100, y: 200 });
    // 不同房间/成员互不影响
    expect(readRemotePos("r", "other", storage)).toBeNull();
    expect(readRemotePos("other", "u", storage)).toBeNull();
  });

  it("returns null for malformed or non-finite stored values", () => {
    expect(readSelfPos(fakeStorage({ "pet-pos:self": "not json" }))).toBeNull();
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"x":1}' }))).toBeNull();
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"x":null,"y":2}' }))).toBeNull();
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"x":"a","y":2}' }))).toBeNull();
  });

  it("reads the legacy contract but refuses unknown coordinate spaces", () => {
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"x":-1920,"y":40}' }))).toEqual({ x: -1920, y: 40 });
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"space":"desktop-physical-v2","x":2000,"y":40}' }))).toBeNull();
    expect(readSelfPos(fakeStorage({ "pet-pos:self": '{"space":null,"x":2000,"y":40}' }))).toBeNull();
    expect(readRemotePos("r", "u", fakeStorage({ "pet-pos:r:u": '{"space":"desktop-physical-v2","x":2000,"y":40}' }))).toBeNull();
  });

  it("ignores writes of non-finite coordinates", () => {
    const storage = fakeStorage();
    writeSelfPos({ x: Number.NaN, y: 0 }, storage);
    expect(readSelfPos(storage)).toBeNull();
  });
});

it("discards unconvertible Windows legacy positions and writes physical desktop records", async () => {
  vi.resetModules(); vi.stubGlobal("navigator", { platform: "Win32" });
  try {
    const store = await import("./petPositionStore.js");
    const storage = fakeStorage({ "pet-pos:self": '{"space":"window-logical-v1","x":1000,"y":40}' });
    expect(store.readSelfPos(storage)).toBeNull();
    store.writeSelfPos({ x: 2000, y: -40 }, storage);
    expect(store.readSelfPos(storage)).toEqual({ x: 2000, y: -40 });
    expect(JSON.parse(storage._map.get("pet-pos:self")!).space).toBe("desktop-physical-v2");
  } finally { vi.unstubAllGlobals(); }
});
