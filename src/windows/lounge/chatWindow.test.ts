import { describe, expect, it } from "vitest";
import { createChatWindow, mergeChatMessages } from "./chatWindow.js";
import type { ChatMessage } from "./chatHistory.js";
function message(id: string, createdAt = "2026-10-01T00:00:00.000001Z"): ChatMessage {
  return { id, createdAt, content: id, senderId: "sender" };
}
describe("bounded chat reading window", () => {
  it("merges live inserts received during the initial snapshot without losing or duplicating them", () => {
    const store = createChatWindow();
    store.live(message("new"));
    store.snapshot([message("old"), message("new")]);
    expect(store.messages.map((item) => item.id)).toEqual(["new", "old"]);
  });
  it("sorts microsecond timestamps before using UUID tie-breakers", () => {
    const result = mergeChatMessages([message("z", "2026-10-01T00:00:00.000001Z"), message("a", "2026-10-01T00:00:00.000002Z")]);
    expect(result.map((item) => item.id)).toEqual(["z", "a"]);
  });
  it("bounds memory while reading older pages and buffers new inserts until returning to latest", () => {
    const store = createChatWindow(3);
    store.snapshot([message("3"), message("4"), message("5")]);
    store.older([message("1"), message("2")]);
    expect(store.messages.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(store.live(message("6"))).toBe(false);
    expect(store.messages.map((item) => item.id)).toEqual(["1", "2", "3"]);
    store.startLatest(); store.snapshot([message("4"), message("5")]);
    expect(store.messages.map((item) => item.id)).toEqual(["4", "5", "6"]);
  });
  it("retains only the recent limit during a long live session", () => {
    const store = createChatWindow(3); store.snapshot([]);
    for (let i = 0; i < 100; i++) store.live(message(String(i).padStart(3, "0")));
    expect(store.messages.map((item) => item.id)).toEqual(["097", "098", "099"]);
  });
});
