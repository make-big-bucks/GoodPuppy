import { describe, expect, it } from "vitest";
import {
  buildMemberViewModels,
  getDisplayName,
  getRoomAction,
  mapPendingRoomInvitationRows,
  normalizeGpId,
} from "./loungeViewModels.js";
import type { LoungeMemberRow, LoungePresenceRow } from "../../types";

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
    const members: LoungeMemberRow[] = [
      { user_id: "u2", joined_at: "2026-06-12T00:00:00Z", profiles: { gp_id: "gp_b", display_name: "B" } },
      { user_id: "u1", joined_at: "2026-06-13T00:00:00Z", profiles: { gp_id: "gp_a", display_name: "A" } },
      { user_id: "u3", joined_at: "2026-06-11T00:00:00Z", profiles: { gp_id: "gp_c", display_name: "C" } },
    ];
    const presence: LoungePresenceRow[] = [{ user_id: "u3", is_online: true }];

    expect(buildMemberViewModels(members, presence, "u1").map((member) => member.userId)).toEqual([
      "u1",
      "u3",
      "u2",
    ]);
  });

  it("uses the active room as the self online source of truth", () => {
    const members: LoungeMemberRow[] = [
      { room_id: "room-1", user_id: "u1", joined_at: "2026-06-13T00:00:00Z", profiles: { gp_id: "gp_a" } },
    ];
    const stalePresence: LoungePresenceRow[] = [
      { user_id: "u1", current_room_id: "room-1", is_online: true },
    ];

    expect(buildMemberViewModels(members, stalePresence, "u1", "room-1", null)[0].isOnline).toBe(false);
    expect(buildMemberViewModels(members, [], "u1", "room-1", "room-1")[0].isOnline).toBe(true);
  });
});

describe("getRoomAction", () => {
  it("returns exit for active room and enter otherwise", () => {
    expect(getRoomAction("room-1", "room-1")).toEqual({ action: "exit", label: "退出房间" });
    expect(getRoomAction("room-2", "room-1")).toEqual({ action: "enter", label: "进入房间" });
  });
});

describe("mapPendingRoomInvitationRows", () => {
  it("maps pending invite RPC rows to the existing request view model shape", () => {
    expect(
      mapPendingRoomInvitationRows([
        {
          id: "request-1",
          from_id: "sender-1",
          room_id: "room-1",
          room_name: "午睡房",
          profile_id: "sender-1",
          gp_id: "gp_sender01",
          display_name: "Nana",
          pet_id: "shiba",
          skin: "mint",
        },
      ]),
    ).toEqual([
      {
        id: "request-1",
        from_id: "sender-1",
        room_id: "room-1",
        rooms: { id: "room-1", room_name: "午睡房" },
        profiles: {
          id: "sender-1",
          gp_id: "gp_sender01",
          display_name: "Nana",
          pet_id: "shiba",
          skin: "mint",
        },
      },
    ]);
  });
});
