import { describe, expect, it } from "vitest";
import { getInviteMetaText } from "./room-list.js";

describe("getInviteMetaText", () => {
  it("shows the target room name when a pending invitation includes room details", () => {
    expect(
      getInviteMetaText({
        id: "request-1",
        from_id: "sender-1",
        rooms: { id: "room-1", room_name: "午睡房" },
        profiles: { gp_id: "gp_sender01" },
      }),
    ).toBe("邀请你加入「午睡房」");
  });

  it("falls back to sender identity when room details are not visible", () => {
    expect(
      getInviteMetaText({
        id: "request-1",
        from_id: "sender-1",
        profiles: { gp_id: "gp_sender01" },
      }),
    ).toBe("gp_sender01");
  });
});
