import { describe, expect, it } from "vitest";
import {
  buildMemberViewModels,
  getDisplayName,
  getRoomAction,
  normalizeGpId,
} from "./loungeViewModels.js";

describe("normalizeGpId", () => {
  it("keeps gp-prefixed short ids and trims whitespace", () => {
    expect(normalizeGpId("  gp_a1b2c3d4  ")).toBe("gp_a1b2c3d4");
  });

  it("rejects auth uuids and non-gp ids", () => {
    expect(normalizeGpId("a1b2c3d4-0000-0000-0000-000000000000")).toBe("");
    expect(normalizeGpId("user_a")).toBe("");
  });
});

describe("getDisplayName", () => {
  it("prefers display_name and falls back to gp_id", () => {
    expect(getDisplayName({ display_name: "Nana", gp_id: "gp_12345678" })).toBe("Nana");
    expect(getDisplayName({ display_name: "", gp_id: "gp_12345678" })).toBe("gp_12345678");
  });
});

describe("buildMemberViewModels", () => {
  it("sorts the current user first and keeps other members stable", () => {
    const members = [
      { user_id: "u2", joined_at: "2026-06-12T00:00:00Z", profiles: { gp_id: "gp_b", display_name: "B" } },
      { user_id: "u1", joined_at: "2026-06-13T00:00:00Z", profiles: { gp_id: "gp_a", display_name: "A" } },
      { user_id: "u3", joined_at: "2026-06-11T00:00:00Z", profiles: { gp_id: "gp_c", display_name: "C" } },
    ];
    const presence = [{ user_id: "u3", is_online: true }];

    expect(buildMemberViewModels(members, presence, "u1").map((member) => member.userId)).toEqual([
      "u1",
      "u3",
      "u2",
    ]);
  });
});

describe("getRoomAction", () => {
  it("returns exit for active room and enter otherwise", () => {
    expect(getRoomAction("room-1", "room-1")).toEqual({ action: "exit", label: "退出房间" });
    expect(getRoomAction("room-2", "room-1")).toEqual({ action: "enter", label: "进入房间" });
  });
});
