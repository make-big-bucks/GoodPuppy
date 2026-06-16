import { describe, expect, it } from "vitest";
import {
  normalizeMessage,
  sortByTime,
  buildMessageList,
  insertMessage,
  trimMessages,
  MAX_STACK_MESSAGES,
  canShowPrevious,
  canShowNext,
} from "./messageLog.js";

describe("normalizeMessage", () => {
  it("returns null for messages without info", () => {
    expect(normalizeMessage(null)).toBeNull();
    expect(normalizeMessage({})).toBeNull();
    expect(normalizeMessage({ info: "" })).toBeNull();
  });

  it("preserves id / from / created_at when provided", () => {
    const msg = normalizeMessage({ id: "1", info: "hi", from: "u", created_at: "2026-01-01T00:00:00Z" });
    expect(msg).toEqual({ id: "1", info: "hi", from: "u", created_at: "2026-01-01T00:00:00Z" });
  });

  it("fills a created_at when missing", () => {
    const msg = normalizeMessage({ id: "1", info: "hi", from: "u" });
    expect(typeof msg?.created_at).toBe("string");
    expect(Number.isNaN(new Date(msg?.created_at ?? "").getTime())).toBe(false);
  });
});

describe("sortByTime / buildMessageList", () => {
  it("orders messages ascending by created_at", () => {
    const out = sortByTime([
      { id: "b", info: "two", from: "u", created_at: "2026-01-02T00:00:00Z" },
      { id: "a", info: "one", from: "u", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("drops invalid entries while normalizing and sorting", () => {
    const out = buildMessageList([
      { id: "b", info: "two", created_at: "2026-01-02T00:00:00Z" },
      { info: "" },
      { id: "a", info: "one", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("insertMessage", () => {
  const history = [{ id: "a", info: "one", from: "u", created_at: "2026-01-01T00:00:00Z" }];

  it("inserts a new message in time order and reports it as inserted", () => {
    const { messages, normalized } = insertMessage(history, {
      id: "b",
      info: "two",
      from: "u",
      created_at: "2026-01-02T00:00:00Z",
    });
    expect(messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(normalized?.id).toBe("b");
  });

  it("ignores duplicate ids and returns the original history reference", () => {
    const { messages, normalized } = insertMessage(history, {
      id: "a",
      info: "dup",
      from: "u",
    });
    expect(messages).toBe(history);
    expect(normalized).toBeNull();
  });

  it("ignores invalid messages", () => {
    const { messages, normalized } = insertMessage(history, { info: "" });
    expect(messages).toBe(history);
    expect(normalized).toBeNull();
  });
});

describe("trimMessages", () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i),
      info: `m${i}`,
      from: "u",
      created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));

  it("keeps the list untouched when within capacity", () => {
    const list = make(3);
    expect(trimMessages(list, 5)).toBe(list);
  });

  it("keeps only the most recent (tail) entries when over capacity", () => {
    const out = trimMessages(make(25), 20);
    expect(out).toHaveLength(20);
    expect(out[0].id).toBe("5");
    expect(out[19].id).toBe("24");
  });

  it("defaults to MAX_STACK_MESSAGES capacity", () => {
    expect(trimMessages(make(50))).toHaveLength(MAX_STACK_MESSAGES);
  });

  it("returns empty for a non-positive capacity", () => {
    expect(trimMessages(make(3), 0)).toEqual([]);
  });
});

describe("navigation bounds", () => {
  it("canShowPrevious is true only past the first item", () => {
    expect(canShowPrevious(0)).toBe(false);
    expect(canShowPrevious(1)).toBe(true);
    expect(canShowPrevious(-1)).toBe(false);
  });

  it("canShowNext is true only before the last item", () => {
    expect(canShowNext(0, 3)).toBe(true);
    expect(canShowNext(2, 3)).toBe(false);
    expect(canShowNext(-1, 3)).toBe(false);
    expect(canShowNext(0, 0)).toBe(false);
  });
});
