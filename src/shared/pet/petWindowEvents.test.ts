import { expect, it } from "vitest";
import { isOwnSkinUpdate } from "./petWindowEvents.js";
it("rejects skin broadcasts from an old account and unbound legacy payloads", () => {
  expect(isOwnSkinUpdate({ userId: "old", skin: "blue" }, "new")).toBe(false);
  expect(isOwnSkinUpdate({ skin: "blue" }, "new")).toBe(false);
  expect(isOwnSkinUpdate({ userId: "new", skin: "blue" }, null)).toBe(false);
  expect(isOwnSkinUpdate({ userId: "new", skin: "blue" }, "new")).toBe(true);
});
