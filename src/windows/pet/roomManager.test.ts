import { beforeEach, describe, expect, it, vi } from "vitest";

const joinRoom = vi.fn();
const leaveRoom = vi.fn();
const joinInteractions = vi.fn();
const leaveInteractions = vi.fn();
const fetchRoomMessages = vi.fn();
const subscribeToRoomMessages = vi.fn();
const unsubscribeRoomMessages = vi.fn();

vi.mock("./presence.js", () => ({
  joinRoom,
  leaveRoom,
}));

vi.mock("./interactions.js", () => ({
  joinInteractions,
  leaveInteractions,
}));

vi.mock("./roomMessages.js", () => ({
  fetchRoomMessages,
  subscribeToRoomMessages,
  unsubscribeRoomMessages,
}));

function createQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockResolvedValue({ error: null }),
    limit: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
}

function createSupabase({
  profileResult = { data: { id: "user-1", pet_id: "shiba" }, error: null },
  presenceResult = { data: { current_room_id: null }, error: null },
  membershipsResult = { data: [{ room_id: "room-1" }], error: null },
} = {}) {
  return {
    from: vi.fn((table: string) => {
      if (table === "profiles") return createQuery(profileResult);
      if (table === "presence") return createQuery(presenceResult);
      if (table === "room_members") return createQuery(membershipsResult);
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
}

function createCallbacks() {
  return {
    onPresenceChange: vi.fn(),
    onInteraction: vi.fn(),
    onMessagesLoaded: vi.fn(),
    onNewMessage: vi.fn(),
    onRoomReady: vi.fn(),
    onEnterRoom: vi.fn(),
    onClearRemotePets: vi.fn(),
    onPetIdResolved: vi.fn(),
    getSelfAnimator: vi.fn(),
    getSelfPetId: vi.fn(() => "shiba"),
    getSelfSkin: vi.fn(() => "default"),
    getSelfStatus: vi.fn(() => null),
  };
}

describe("roomManager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchRoomMessages.mockResolvedValue([]);
    subscribeToRoomMessages.mockResolvedValue(undefined);
    joinRoom.mockResolvedValue(undefined);
    leaveRoom.mockResolvedValue(undefined);
    joinInteractions.mockResolvedValue(undefined);
    leaveInteractions.mockResolvedValue(undefined);
    unsubscribeRoomMessages.mockResolvedValue(undefined);
  });

  it("does not auto-activate a membership when no active room is stored", async () => {
    const roomManager = await import("./roomManager.js");
    const callbacks = createCallbacks();
    roomManager.initRoomManager(callbacks);

    roomManager.startPetApp({
      supabase: createSupabase() as never,
      session: { user: { id: "user-1" } } as never,
    });

    await vi.waitFor(() => expect(callbacks.onRoomReady).toHaveBeenCalledTimes(1));

    expect(roomManager.getCurrentRoomId()).toBeNull();
    expect(joinRoom).not.toHaveBeenCalled();
    expect(joinInteractions).not.toHaveBeenCalled();
  });

  it("marks presence offline on startup when no active room is stored", async () => {
    const roomManager = await import("./roomManager.js");
    const callbacks = createCallbacks();
    const presenceQuery = createQuery({ data: { current_room_id: null, is_online: true }, error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") return createQuery({ data: { id: "user-1", pet_id: "shiba" }, error: null });
        if (table === "presence") return presenceQuery;
        if (table === "room_members") return createQuery({ data: [{ room_id: "room-1" }], error: null });
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    roomManager.initRoomManager(callbacks);

    roomManager.startPetApp({
      supabase: supabase as never,
      session: { user: { id: "user-1" } } as never,
    });
    await vi.waitFor(() => expect(callbacks.onRoomReady).toHaveBeenCalledTimes(1));

    expect(presenceQuery.update).toHaveBeenCalledWith({
      current_room_id: null,
      is_online: false,
      last_seen: expect.any(String),
    });
  });

  it("clears the stored active room when exiting the current room", async () => {
    const roomManager = await import("./roomManager.js");
    const callbacks = createCallbacks();
    const presenceQuery = createQuery({ data: { current_room_id: null }, error: null });
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "profiles") return createQuery({ data: { id: "user-1", pet_id: "shiba" }, error: null });
        if (table === "presence") return presenceQuery;
        if (table === "room_members") return createQuery({ data: [{ room_id: "room-1" }], error: null });
        throw new Error(`Unexpected table: ${table}`);
      }),
    };
    roomManager.initRoomManager(callbacks);

    roomManager.startPetApp({
      supabase: supabase as never,
      session: { user: { id: "user-1" } } as never,
    });
    await vi.waitFor(() => expect(callbacks.onRoomReady).toHaveBeenCalledTimes(1));

    await roomManager.switchRoom("room-1");
    await roomManager.exitCurrentRoom();

    expect(presenceQuery.update).toHaveBeenLastCalledWith({
      current_room_id: null,
      is_online: false,
      last_seen: expect.any(String),
    });
    expect(roomManager.getCurrentRoomId()).toBeNull();
    expect(callbacks.onClearRemotePets).toHaveBeenCalledTimes(1);
  });
});
