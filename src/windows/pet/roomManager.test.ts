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
    subscribeToRoomMessages.mockImplementation(async (_client, _room, _message, connected) => { connected?.(true); });
    joinRoom.mockImplementation(async (_client, _room, _self, options) => { options?.onConnectionChange?.(true); });
    leaveRoom.mockResolvedValue(undefined);
    joinInteractions.mockImplementation(async (_client, _room, options) => { options?.onConnectionChange?.(true); });
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
  async function initialized() {
    const manager = await import("./roomManager.js");
    const cbs = createCallbacks();
    const client = createSupabase();
    manager.initRoomManager(cbs);
    await manager.startPetApp({ supabase: client as never, session: { user: { id: "user-1" } } as never });
    return { manager, cbs, client };
  }

  it("marks a disconnected room offline and restores its lease only when all channels are ready", async () => {
    const { manager, client } = await initialized();
    const query = createQuery({ data: null, error: null });
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    await manager.switchRoom("room-a");
    const messagesConnected = subscribeToRoomMessages.mock.calls[0][3];
    const presenceConnected = joinRoom.mock.calls[0][3].onConnectionChange;
    messagesConnected(false); presenceConnected(false);
    await vi.waitFor(() => expect(query.update).toHaveBeenLastCalledWith({ is_online: false, last_seen: expect.any(String) }));
    messagesConnected(true);
    await vi.waitFor(() => expect(query.update).toHaveBeenLastCalledWith({ is_online: false, last_seen: expect.any(String) }));
    presenceConnected(true);
    await vi.waitFor(() => expect(query.update).toHaveBeenLastCalledWith({ is_online: true, last_seen: expect.any(String) }));
    await manager.exitCurrentRoom(); const count = query.update.mock.calls.length;
    messagesConnected(true); presenceConnected(true);
    await Promise.resolve(); expect(query.update).toHaveBeenCalledTimes(count);
    expect(query.update).toHaveBeenLastCalledWith({ current_room_id: null, is_online: false, last_seen: expect.any(String) });
  });

  it("rejects entry when an earlier channel disconnects during final online persistence", async () => {
    const { manager, client } = await initialized();
    const query = createQuery({ data: null, error: null });
    let finish!: (value: { error: null }) => void;
    query.upsert.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    const entering = manager.switchRoom("room-a");
    const rejection = expect(entering).rejects.toThrow("准备期间中断");
    await vi.waitFor(() => expect(query.upsert).toHaveBeenCalled());
    subscribeToRoomMessages.mock.calls[0][3](false); finish({ error: null });
    await rejection; expect(manager.getCurrentRoomId()).toBeNull();
    expect(query.update).toHaveBeenLastCalledWith({ current_room_id: null, is_online: false, last_seen: expect.any(String) });
  });

  it("finishes an in-flight old heartbeat before persisting the new room", async () => {
    const { manager, client } = await initialized();
    const query = createQuery({ data: null, error: null });
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    await manager.switchRoom("room-a");
    let finish!: (value: { error: null }) => void;
    query.eq.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
    const oldHealth = subscribeToRoomMessages.mock.calls[0][3]; oldHealth(false);
    await vi.waitFor(() => expect(query.eq).toHaveBeenCalled());
    const switching = manager.switchRoom("room-b");
    await Promise.resolve(); expect(query.upsert).toHaveBeenCalledTimes(1);
    finish({ error: null }); await switching;
    expect(query.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ current_room_id: "room-b", is_online: true }), { onConflict: "user_id" });
    const count = query.update.mock.calls.length; oldHealth(true); oldHealth(false);
    await Promise.resolve(); expect(query.update).toHaveBeenCalledTimes(count);
    await manager.exitCurrentRoom();
  });

  it("invalidates an entry immediately when exit occurs during history loading", async () => {
    const { manager, cbs } = await initialized();
    let finish!: (messages: never[]) => void;
    fetchRoomMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const entering = manager.switchRoom("room-a").catch((error) => error);
    await vi.waitFor(() => expect(fetchRoomMessages).toHaveBeenCalledTimes(1));
    const exiting = manager.exitCurrentRoom();
    expect(manager.getCurrentRoomId()).toBeNull();
    finish([]);
    expect((await entering).name).toBe("AbortError");
    await exiting;
    expect(joinRoom).not.toHaveBeenCalled();
    expect(cbs.onMessagesLoaded).not.toHaveBeenCalled();
  });

  it("does not let late room A results replace room B", async () => {
    const { manager } = await initialized();
    let finish!: (messages: never[]) => void;
    fetchRoomMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const enteringA = manager.switchRoom("room-a").catch((error) => error);
    await vi.waitFor(() => expect(fetchRoomMessages).toHaveBeenCalledTimes(1));
    const enteringB = manager.switchRoom("room-b");
    finish([]);
    expect((await enteringA).name).toBe("AbortError");
    await enteringB;
    expect(manager.getCurrentRoomId()).toBe("room-b");
    expect(joinRoom.mock.calls.map((call) => call[1])).toEqual(["room-b"]);
    await manager.exitCurrentRoom();
  });

  it("buffers and deduplicates realtime messages while loading history", async () => {
    const { manager, cbs } = await initialized();
    const message = { id: "m1", from: "user-2", info: "hello", created_at: "2026-10-01T00:00:00Z" };
    subscribeToRoomMessages.mockImplementationOnce(async (_client, _room, onMessage, connected) => { connected?.(true); onMessage(message); });
    fetchRoomMessages.mockResolvedValueOnce([message]);
    await manager.switchRoom("room-a");
    expect(cbs.onMessagesLoaded).toHaveBeenCalledWith([message]);
    expect(cbs.onNewMessage).not.toHaveBeenCalled();
    const oldCallback = subscribeToRoomMessages.mock.calls[0][2];
    await manager.exitCurrentRoom();
    oldCallback(message);
    expect(cbs.onNewMessage).not.toHaveBeenCalled();
  });

  it("commits room state only after online persistence succeeds", async () => {
    const { manager } = await initialized();
    let finish!: (result: { error: null }) => void;
    const query = createQuery({ data: null, error: null });
    query.upsert.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const client = manager.getActiveSupabase() as unknown as ReturnType<typeof createSupabase>;
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    const entering = manager.switchRoom("room-a");
    await vi.waitFor(() => expect(query.upsert).toHaveBeenCalled());
    expect(manager.getCurrentRoomId()).toBeNull();
    finish({ error: null });
    await entering;
    expect(manager.getCurrentRoomId()).toBe("room-a");
    await manager.exitCurrentRoom();
  });

  it("clears identity immediately and cancels pending entry on logout", async () => {
    const { manager } = await initialized();
    let finish!: (messages: never[]) => void;
    fetchRoomMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const entering = manager.switchRoom("room-a").catch((error) => error);
    await vi.waitFor(() => expect(fetchRoomMessages).toHaveBeenCalled());
    const stopping = manager.stopPetApp();
    expect(manager.getSelfAuthId()).toBeNull();
    expect(manager.getActiveSupabase()).toBeNull();
    finish([]);
    expect((await entering).name).toBe("AbortError");
    await stopping;
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("rejects failed entry and releases all resources even if a cleanup fails", async () => {
    const { manager } = await initialized();
    joinRoom.mockRejectedValueOnce(new Error("track failed"));
    await expect(manager.switchRoom("room-a")).rejects.toThrow("track failed");
    expect(manager.getCurrentRoomId()).toBeNull();
    await manager.switchRoom("room-b");
    leaveInteractions.mockRejectedValueOnce(new Error("unsubscribe failed"));
    const exiting = manager.exitCurrentRoom();
    expect(manager.getCurrentRoomId()).toBeNull();
    await expect(exiting).rejects.toThrow("unsubscribe failed");
    expect(unsubscribeRoomMessages).toHaveBeenCalled();
    expect(leaveRoom).toHaveBeenCalled();
  });

  it("deduplicates repeated initialization for the same authenticated session", async () => {
    const { manager, client, cbs } = await initialized();
    await manager.startPetApp({ supabase: client as never, session: { user: { id: "user-1" } } as never });
    expect(cbs.onRoomReady).toHaveBeenCalledTimes(1);
  });

  it("marks offline without clearing the remembered room on application quit", async () => {
    const { manager, client } = await initialized();
    const query = createQuery({ data: null, error: null });
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    await manager.switchRoom("room-a");
    await manager.exitCurrentRoom({ rememberRoom: true });
    expect(query.update).toHaveBeenLastCalledWith({
      is_online: false, last_seen: expect.any(String),
    });
    expect(manager.getCurrentRoomId()).toBeNull();
  });

});

it("restores the authenticated account skin instead of using device-global skin", async () => {
  vi.resetModules();
  const manager = await import("./roomManager.js");
  const callbacks = { ...createCallbacks(), onSkinResolved: vi.fn() };
  manager.initRoomManager(callbacks);
  await manager.startPetApp({ supabase: createSupabase({ profileResult: { data: { id: "user-1", pet_id: "shiba", skin: "blue" }, error: null } as never }) as never,
    session: { user: { id: "user-1" } } as never });
  expect(callbacks.onSkinResolved).toHaveBeenCalledWith("blue");
});
