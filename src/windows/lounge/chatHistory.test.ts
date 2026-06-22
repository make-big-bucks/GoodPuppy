import { describe, it, expect } from "vitest";
import {
  assemblePage,
  formatDayLabel,
  formatTime,
  isSameDay,
  resolveSender,
  rowToMessage,
  senderColor,
  PAGE_SIZE,
  type ChatMessageRow,
} from "./chatHistory.js";

function makeRow(id: string, created_at: string, sender_id = "u1"): ChatMessageRow {
  return { id, content: `m-${id}`, sender_id, created_at };
}

describe("resolveSender", () => {
  it("uses the current display_name so renames follow", () => {
    const identity = resolveSender("u1", { display_name: "Nana", gp_id: "gp_11111111" });
    expect(identity).toMatchObject({ name: "Nana", isDeleted: false });
  });

  it("falls back to gp_id when display_name is empty", () => {
    expect(resolveSender("u1", { display_name: "", gp_id: "gp_22222222" }).name).toBe("gp_22222222");
  });

  it("labels missing profiles as 已注销用户 with a stable id suffix", () => {
    const identity = resolveSender("11111111-2222-3333-4444-aaaabbbbccdd", null);
    expect(identity.isDeleted).toBe(true);
    expect(identity.name).toBe("已注销用户·ccdd");
  });

  it("distinguishes multiple deleted accounts by their id suffix", () => {
    const a = resolveSender("aaaa1111-0000-0000-0000-00000000aaaa", null);
    const b = resolveSender("bbbb2222-0000-0000-0000-00000000bbbb", null);
    expect(a.name).not.toBe(b.name);
  });
});

describe("senderColor", () => {
  it("is deterministic per sender", () => {
    expect(senderColor("u1")).toBe(senderColor("u1"));
  });

  it("returns a hex color", () => {
    expect(senderColor("someone")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("assemblePage", () => {
  it("reverses descending rows into ascending messages", () => {
    const rows = [makeRow("c", "2026-06-19T03:00:00Z"), makeRow("b", "2026-06-19T02:00:00Z"), makeRow("a", "2026-06-19T01:00:00Z")];
    const page = assemblePage(rows);
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(page.nextCursor).toBe("2026-06-19T01:00:00Z");
  });

  it("reports hasMore only when a full page is returned", () => {
    expect(assemblePage([makeRow("a", "2026-06-19T01:00:00Z")]).hasMore).toBe(false);
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => makeRow(String(i), `2026-06-19T00:00:${String(i).padStart(2, "0")}Z`));
    expect(assemblePage(full).hasMore).toBe(true);
  });

  it("returns a null cursor for an empty page", () => {
    expect(assemblePage([]).nextCursor).toBeNull();
  });
});

describe("rowToMessage", () => {
  it("maps snake_case row fields to the view model", () => {
    expect(rowToMessage(makeRow("x", "2026-06-19T01:00:00Z", "u9"))).toEqual({
      id: "x",
      content: "m-x",
      senderId: "u9",
      createdAt: "2026-06-19T01:00:00Z",
    });
  });
});

describe("date formatting", () => {
  const now = new Date(2026, 5, 19, 12, 0, 0); // 2026-06-19 local

  it("labels today and yesterday", () => {
    expect(formatDayLabel(new Date(2026, 5, 19, 9, 0).toISOString(), now)).toBe("今天");
    expect(formatDayLabel(new Date(2026, 5, 18, 9, 0).toISOString(), now)).toBe("昨天");
  });

  it("uses M月D日 within the same year and adds the year otherwise", () => {
    expect(formatDayLabel(new Date(2026, 5, 1, 9, 0).toISOString(), now)).toBe("6月1日");
    expect(formatDayLabel(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe("2025年12月31日");
  });

  it("formats time as HH:mm", () => {
    expect(formatTime(new Date(2026, 5, 19, 8, 5).toISOString())).toBe("08:05");
  });

  it("detects same-day across different times", () => {
    expect(isSameDay(new Date(2026, 5, 19, 1, 0).toISOString(), new Date(2026, 5, 19, 23, 0).toISOString())).toBe(true);
    expect(isSameDay(new Date(2026, 5, 19, 1, 0).toISOString(), new Date(2026, 5, 20, 1, 0).toISOString())).toBe(false);
  });
});
