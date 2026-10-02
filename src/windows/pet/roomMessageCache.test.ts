import { expect, it } from "vitest";
import { createRoomMessageCache } from "./roomMessageCache.js";
const message = (id: string, from = "self", time = "2026-10-01T00:00:00.000001Z") => ({ id, from, info: id, created_at: time });
it("normalizes unordered duplicate history before applying the same bound used by live messages", () => {
  const cache = createRoomMessageCache(3);
  cache.replace([message("d"), message("a"), message("c"), message("b"), message("c")]);
  expect(cache.forSender("self").map(m => m.id)).toEqual(["b", "c", "d"]);
  expect(cache.append(message("c"))).toBe(false);
  cache.append(message("e", "remote"));
  expect(cache.forSender("self").map(m => m.id)).toEqual(["c", "d"]);
  expect(cache.senders).toEqual(["self", "remote"]);
  cache.clear(); expect(cache.senders).toEqual([]);
});
it("retains the newest precise cursor rather than the last element of an unsorted snapshot", () => {
  const cache = createRoomMessageCache(1);
  cache.replace([message("new", "self", "2026-10-01T00:00:00.000002Z"), message("old")]);
  expect(cache.forSender("self").map(m => m.id)).toEqual(["new"]);
});
