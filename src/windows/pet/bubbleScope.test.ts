import { expect, it } from "vitest";
import { bubbleScopeKey } from "./bubbleScope.js";
import { compareMessagePosition } from "../../shared/messageOrder.js";
it("separates viewer, room and sender scope", () => {
  const scope = { viewerId: "a", roomId: "room", senderId: "self" };
  expect(bubbleScopeKey(scope)).not.toBe(bubbleScopeKey({ ...scope, viewerId: "b" }));
  expect(bubbleScopeKey(scope)).not.toBe(bubbleScopeKey({ ...scope, roomId: "other" }));
});
it("preserves microseconds and IDs in a dismiss cursor", () => {
  expect(compareMessagePosition({ id: "a", createdAt: "2026-10-01T00:00:00.000002Z" }, { id: "z", createdAt: "2026-10-01T00:00:00.000001Z" })).toBeGreaterThan(0);
});
