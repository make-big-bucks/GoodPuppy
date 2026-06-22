import { describe, expect, it } from "vitest";
import { isOfflineError } from "./panelState.js";

describe("isOfflineError", () => {
  it("returns true when the browser reports offline regardless of error", () => {
    expect(isOfflineError(new Error("anything"), false)).toBe(true);
    expect(isOfflineError(null, false)).toBe(true);
  });

  it("detects network-style fetch errors while online", () => {
    expect(isOfflineError(new TypeError("Failed to fetch"), true)).toBe(true);
    expect(isOfflineError(new Error("NetworkError when attempting to fetch resource"), true)).toBe(true);
    expect(isOfflineError({ message: "Network request failed" }, true)).toBe(true);
  });

  it("treats non-network errors while online as not offline", () => {
    expect(isOfflineError(new Error("permission denied"), true)).toBe(false);
    expect(isOfflineError({ message: "row level security" }, true)).toBe(false);
    expect(isOfflineError(null, true)).toBe(false);
  });
});
