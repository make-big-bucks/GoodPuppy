import { describe, expect, it } from "vitest";
import { bubbleClassName } from "./messageBubble.js";

describe("bubbleClassName", () => {
  it("marks only the newly inserted message for entry animation", () => {
    expect(bubbleClassName("new", "new")).toBe("bubble is-entering");
    expect(bubbleClassName("old", "new")).toBe("bubble");
  });

  it("does not mark history replay messages for entry animation", () => {
    expect(bubbleClassName("new", null)).toBe("bubble");
  });
});
