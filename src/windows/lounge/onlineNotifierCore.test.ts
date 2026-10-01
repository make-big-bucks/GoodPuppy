import { describe, it, expect } from "vitest";
import {
  nextPresenceRoom,
  decideOnlineNotification,
  computeToastPosition,
  subscriptionStorageKey,
  readSubscribedRooms,
  writeSubscribedRooms,
  isWithinDedupeWindow,
} from "./onlineNotifierCore.js";

describe("nextPresenceRoom", () => {
  it("returns room id when online in a room", () => {
    expect(nextPresenceRoom({ user_id: "u", is_online: true, current_room_id: "R" })).toBe("R");
  });

  it("returns null when offline", () => {
    expect(nextPresenceRoom({ user_id: "u", is_online: false, current_room_id: "R" })).toBeNull();
  });

  it("returns null when online but without a room", () => {
    expect(nextPresenceRoom({ user_id: "u", is_online: true, current_room_id: null })).toBeNull();
  });
});

describe("decideOnlineNotification", () => {
  const base = {
    selfId: "self",
    activeRoomId: null as string | null,
    isSubscribed: () => true,
    isDeduped: () => false,
  };

  it("notifies when a subscribed-room member first comes online", () => {
    const out = decideOnlineNotification({
      ...base,
      prevRoom: undefined,
      row: { user_id: "bob", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: true, roomId: "R" });
  });

  it("notifies when a member switches into a subscribed room", () => {
    const out = decideOnlineNotification({
      ...base,
      prevRoom: "A",
      row: { user_id: "bob", is_online: true, current_room_id: "B" },
    });
    expect(out).toEqual({ shouldNotify: true, roomId: "B" });
  });

  it("does not notify on a same-room heartbeat repeat", () => {
    const out = decideOnlineNotification({
      ...base,
      prevRoom: "R",
      row: { user_id: "bob", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: "R" });
  });

  it("does not notify for self", () => {
    const out = decideOnlineNotification({
      ...base,
      prevRoom: undefined,
      row: { user_id: "self", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: "R" });
  });

  it("does not notify for the user's current active room", () => {
    const out = decideOnlineNotification({
      ...base,
      activeRoomId: "R",
      prevRoom: undefined,
      row: { user_id: "bob", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: "R" });
  });

  it("does not notify for an unsubscribed room", () => {
    const out = decideOnlineNotification({
      ...base,
      isSubscribed: () => false,
      prevRoom: undefined,
      row: { user_id: "bob", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: "R" });
  });

  it("does not notify when within the dedupe window", () => {
    const out = decideOnlineNotification({
      ...base,
      isDeduped: () => true,
      prevRoom: undefined,
      row: { user_id: "bob", is_online: true, current_room_id: "R" },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: "R" });
  });

  it("records offline transition without notifying", () => {
    const out = decideOnlineNotification({
      ...base,
      prevRoom: "R",
      row: { user_id: "bob", is_online: false, current_room_id: null },
    });
    expect(out).toEqual({ shouldNotify: false, roomId: null });
  });
});

describe("computeToastPosition", () => {
  const workArea = { x: 0, y: 0, width: 1000, height: 800 };
  const card = { width: 300, height: 100 };

  it("places macOS toasts at the top-right, stacking downward", () => {
    expect(computeToastPosition({ workArea, platform: "macos", index: 0, card, margin: 16, gap: 12 })).toEqual({
      x: 684,
      y: 16,
    });
    expect(computeToastPosition({ workArea, platform: "macos", index: 1, card, margin: 16, gap: 12 })).toEqual({
      x: 684,
      y: 128,
    });
  });

  it("places Windows toasts at the bottom-right, stacking upward", () => {
    expect(computeToastPosition({ workArea, platform: "windows", index: 0, card, margin: 16, gap: 12 })).toEqual({
      x: 684,
      y: 684,
    });
    expect(computeToastPosition({ workArea, platform: "windows", index: 1, card, margin: 16, gap: 12 })).toEqual({
      x: 684,
      y: 572,
    });
  });

  it("offsets by the target monitor's work-area origin", () => {
    const secondary = { x: 1000, y: 0, width: 1000, height: 800 };
    expect(computeToastPosition({ workArea: secondary, platform: "macos", index: 0, card, margin: 16, gap: 12 })).toEqual({
      x: 1684,
      y: 16,
    });
  });
});

describe("subscription storage", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("isolates the key by account", () => {
    expect(subscriptionStorageKey("alice")).toBe("goodpuppy.onlineNotify.alice");
    expect(subscriptionStorageKey("bob")).not.toBe(subscriptionStorageKey("alice"));
  });

  it("defaults to no subscribed rooms", () => {
    const storage = fakeStorage();
    expect(readSubscribedRooms(storage, "alice")).toEqual(new Set());
  });

  it("round-trips subscribed rooms", () => {
    const storage = fakeStorage();
    writeSubscribedRooms(storage, "alice", new Set(["R1", "R2"]));
    expect(readSubscribedRooms(storage, "alice")).toEqual(new Set(["R1", "R2"]));
  });

  it("keeps accounts separate", () => {
    const storage = fakeStorage();
    writeSubscribedRooms(storage, "alice", new Set(["R1"]));
    writeSubscribedRooms(storage, "bob", new Set(["R2"]));
    expect(readSubscribedRooms(storage, "alice")).toEqual(new Set(["R1"]));
    expect(readSubscribedRooms(storage, "bob")).toEqual(new Set(["R2"]));
  });

  it("tolerates corrupt stored values", () => {
    const storage = fakeStorage();
    storage.setItem(subscriptionStorageKey("alice"), "not json");
    expect(readSubscribedRooms(storage, "alice")).toEqual(new Set());
  });
});

describe("isWithinDedupeWindow", () => {
  it("is false when no prior notification", () => {
    expect(isWithinDedupeWindow(undefined, 1000, 10_000)).toBe(false);
  });

  it("is true within the window", () => {
    expect(isWithinDedupeWindow(1000, 5000, 10_000)).toBe(true);
  });

  it("is false once the window has elapsed", () => {
    expect(isWithinDedupeWindow(1000, 12_000, 10_000)).toBe(false);
  });
});

it("scales toast cards and spacing in the target physical desktop plane", () => {
  expect(computeToastPosition({ workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    platform: "windows", index: 1, card: { width: 340, height: 104 }, desktopScale: 2 })).toEqual({ x: 3768, y: 928 });
});
