import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const joinRoom = vi.fn();
const leaveRoom = vi.fn();
const updateLocalPresence = vi.fn();
const activatePresence = vi.fn();
const heartbeatPresence = vi.fn();
const joinInteractions = vi.fn();
const leaveInteractions = vi.fn();
const fetchRoomMessages = vi.fn();
const subscribeToRoomMessages = vi.fn();
const unsubscribeRoomMessages = vi.fn();

vi.mock("./presence.js", () => ({
  joinRoom,
  leaveRoom,
  updateLocalPresence, activatePresence, heartbeatPresence,
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
    abortSignal: vi.fn().mockReturnThis(),
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
    updateLocalPresence.mockResolvedValue(undefined);
    activatePresence.mockResolvedValue(undefined); heartbeatPresence.mockResolvedValue(undefined);
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
  it("keeps a refreshed token session but rebuilds the room for a new Auth session of the same account", async () => {
    const manager = await import("./roomManager.js"); manager.initRoomManager(createCallbacks());
    const client = createSupabase({ presenceResult: { data: { current_room_id: "room-a", is_online: false }, error: null } as never });
    const token = (id: string, exp: number) => `header.${btoa(JSON.stringify({ session_id: id, exp }))}.signature`;
    const start = (id: string, exp: number) => manager.startPetApp({ supabase: client as never,
      session: { user: { id: "user-1" }, access_token: token(id, exp) } as never });
    await start("aaaaaaaa-0000-0000-0000-000000000001", 1);
    await start("aaaaaaaa-0000-0000-0000-000000000001", 2);
    expect(joinRoom).toHaveBeenCalledTimes(1);
    await start("aaaaaaaa-0000-0000-0000-000000000002", 3);
    expect(joinRoom).toHaveBeenCalledTimes(2); expect(manager.getCurrentRoomId()).toBe("room-a");
    await manager.exitCurrentRoom();
  });
  it("retries the same session after remembered-room activation fails", async () => {
    const manager = await import("./roomManager.js");
    const cbs = createCallbacks(); manager.initRoomManager(cbs);
    const client = createSupabase({ presenceResult: { data: { current_room_id: "room-a" }, error: null } as never });
    const options = { supabase: client as never, session: { user: { id: "user-1" } } as never };
    joinRoom.mockRejectedValueOnce(new Error("temporary subscription failure"));
    await expect(manager.startPetApp(options)).rejects.toThrow("temporary subscription failure");
    expect(manager.getCurrentRoomId()).toBeNull();
    await manager.startPetApp(options);
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(manager.getCurrentRoomId()).toBe("room-a");
    await manager.exitCurrentRoom();
  });

  it("keeps a newer explicit room when startup restoration is canceled", async () => {
    const manager = await import("./roomManager.js"); manager.initRoomManager(createCallbacks());
    const client = createSupabase({ presenceResult: { data: { current_room_id: "room-a" }, error: null } as never });
    const options = { supabase: client as never, session: { user: { id: "user-1" } } as never };
    let finish!: (messages: never[]) => void;
    fetchRoomMessages.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const starting = manager.startPetApp(options);
    const canceled = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchRoomMessages).toHaveBeenCalled());
    const switching = manager.switchRoom("room-b"); finish([]);
    await canceled; await switching;
    await manager.startPetApp(options);
    expect(manager.getCurrentRoomId()).toBe("room-b");
    expect(joinRoom).toHaveBeenCalledTimes(1);
    await manager.exitCurrentRoom();
  });

  it("publishes the latest appearance when it changes during room preparation", async () => {
    const { manager, cbs } = await initialized();
    let finish!: () => void;
    joinInteractions.mockImplementationOnce(async (_client, _room, options) => {
      options.onConnectionChange(true);
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const entering = manager.switchRoom("room-a");
    await vi.waitFor(() => expect(joinInteractions).toHaveBeenCalled());
    cbs.getSelfSkin.mockReturnValue("pink"); finish(); await entering;
    expect(updateLocalPresence).toHaveBeenCalledWith(expect.objectContaining({ skin: "pink" }));
    await manager.exitCurrentRoom();
  });

  it("hides stale room state, rechecks membership and restores fresh channels after resume", async () => {
    const { manager, cbs, client } = await initialized();
    await manager.switchRoom("room-a"); const revision = manager.getRoomRevision();
    const recovering = manager.recoverRoomAfterResume();
    expect(manager.getCurrentRoomId()).toBeNull(); expect(manager.getRoomRevision()).toBeGreaterThan(revision);
    expect(manager.recoverRoomAfterResume()).toBe(recovering);
    await recovering;
    expect(client.from).toHaveBeenCalledWith("room_members");
    expect(joinRoom).toHaveBeenCalledTimes(2); expect(manager.getCurrentRoomId()).toBe("room-a");
    expect(cbs.onClearRemotePets).toHaveBeenCalledTimes(1); await manager.exitCurrentRoom();
  });

  it("clears a remembered room when membership no longer exists after resume", async () => {
    const { manager, client } = await initialized(); await manager.switchRoom("room-a");
    const presence = createQuery({ data: null, error: null }); const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "room_members" ? createQuery({ data: null, error: null })
      : table === "presence" ? presence : original(table));
    await manager.recoverRoomAfterResume(); expect(manager.getCurrentRoomId()).toBeNull();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(presence.update).toHaveBeenLastCalledWith({ current_room_id: null, is_online: false, last_seen: expect.any(String) });
  });
  it("clears lost membership even when preserving its old room is rejected by RLS", async () => {
    const { manager, client } = await initialized(); await manager.switchRoom("room-a");
    const presence = createQuery({ data: null, error: null }); const original = client.from.getMockImplementation()!;
    presence.update.mockImplementation((patch) => {
      presence.eq.mockImplementationOnce(async () => {
        if (patch.current_room_id === undefined) throw new Error("RLS rejects old member room");
        return { error: null };
      });
      return presence;
    });
    client.from.mockImplementation((table) => table === "room_members" ? createQuery({ data: null, error: null })
      : table === "presence" ? presence : original(table));
    await manager.recoverRoomAfterResume();
    expect(manager.getCurrentRoomId()).toBeNull(); expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(presence.update).toHaveBeenLastCalledWith({ current_room_id: null, is_online: false, last_seen: expect.any(String) });
  });

  it("retains the remembered room on recovery failure and cancels retry when explicitly leaving", async () => {
    const { manager, client } = await initialized(); await manager.switchRoom("room-a");
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    const presence = createQuery({ data: null, error: null }); const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "room_members" ? createQuery({ data: null, error: new Error("network down") })
      : table === "presence" ? presence : original(table));
    const recovering = manager.recoverRoomAfterResume();
    const rejection = expect(recovering).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(presence.update).toHaveBeenLastCalledWith({ is_online: false, last_seen: expect.any(String) });
    await manager.exitCurrentRoom(); await rejection;
    const calls = client.from.mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
    expect(client.from).toHaveBeenCalledTimes(calls);
    expect(presence.update).toHaveBeenLastCalledWith({ current_room_id: null, is_online: false, last_seen: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers automatically when the membership query becomes available on retry", async () => {
    const { manager, client } = await initialized(); await manager.switchRoom("room-a");
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    const members = createQuery({ data: { room_id: "room-a" }, error: null });
    members.maybeSingle.mockResolvedValueOnce({ data: null, error: new Error("network down") });
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "room_members" ? members : original(table));
    const recovering = manager.recoverRoomAfterResume();
    await vi.advanceTimersByTimeAsync(0); expect(manager.getCurrentRoomId()).toBeNull();
    await vi.advanceTimersByTimeAsync(5000); await recovering;
    expect(manager.getCurrentRoomId()).toBe("room-a"); expect(members.maybeSingle).toHaveBeenCalledTimes(2);
    await manager.exitCurrentRoom(); expect(vi.getTimerCount()).toBe(0);
  });

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

  it("updates the authenticated lease even when the compatibility heartbeat fails", async () => {
    const { manager, client } = await initialized();
    await manager.switchRoom("room-a");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const query = createQuery({ data: null, error: null });
    query.eq.mockResolvedValue({ error: new Error("compatibility write rejected") } as never);
    const original = client.from.getMockImplementation()!;
    client.from.mockImplementation((table) => table === "presence" ? query : original(table));
    subscribeToRoomMessages.mock.calls[0][3](false);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(heartbeatPresence).toHaveBeenCalledWith(false);
    expect(query.update).toHaveBeenCalledWith({ is_online: false, last_seen: expect.any(String) });
    client.from.mockImplementation(original);
    await manager.exitCurrentRoom();
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
