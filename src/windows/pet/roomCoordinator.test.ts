import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventSubscription } from "../../shared/eventSubscription.js";
import { createRoomCoordinator } from "./roomCoordinator.js";
import { WINDOW_READY, WINDOW_READY_REQUEST } from "./windowReadiness.js";

vi.mock("../../shared/pet/animationCatalog.js", () => ({ INTERACTIONS: {}, durationFromManifest: () => 20, loadPetManifest: async () => ({ states: {} }) }));
vi.mock("./interactions.js", () => ({ sendInteraction: vi.fn() }));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function fixture() {
  let room: string | null = "room-a";
  const listeners = new Map<string, (payload: any) => void>();
  const managed = new Map<string, string>();
  const send = vi.fn(async (label, event, payload) => {
    if (event === WINDOW_READY_REQUEST && managed.get(label) === payload.instanceId) {
      listeners.get(WINDOW_READY)?.({ label, instanceId: payload.instanceId, controllerId: payload.controllerId });
    }
  });
  const bridge = {
    getWindowInstance: () => "controller", getManagedWindowInstance: async (label: string) => managed.get(label) ?? null,
    onAppEvent: <T>(event: string, callback: (payload: T) => void) => createEventSubscription<T>(async (handler) => {
      listeners.set(event, handler); return () => listeners.delete(event);
    }, callback),
    emitToWindow: send,
    getWindowBounds: async () => ({ x: 100, y: 100, width: 150, height: 120, scaleFactor: 1, desktopScale: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPetWindowBounds: async () => ({ x: 100, y: 100, width: 150, height: 120, scaleFactor: 1, desktopScale: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getWindowPosition: async () => ({ x: 100, y: 100 }), getWindowSize: async () => ({ width: 150, height: 120 }),
    getMonitors: async () => [{ x: 0, y: 0, width: 1920, height: 1080 }], getPetMonitorWorkArea: async () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    spawnPetWindow: vi.fn(async (options) => { managed.set(options.label, options.instanceId); }),
    spawnBubbleWindow: vi.fn(async (options) => { managed.set(options.label, options.instanceId); }),
    closeBubbleWindow: vi.fn(async (label, instance) => { if (managed.get(label) === instance) managed.delete(label); }),
    closePetWindow: vi.fn(async (label, instance) => { if (managed.get(label) === instance) managed.delete(label); }),
  };
  vi.stubGlobal("window", { goodPuppy: bridge });
  const coordinator = createRoomCoordinator({ getCurrentRoomId: () => room, getSelfAuthId: () => "self",
    selfPresenter: { animator: {} } as never });
  return { coordinator, bridge, managed, send, setRoom: (next: string | null) => { room = next; } };
}
const member = { userId: "a", petId: "default", skin: "default", status: null };
beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("remote window lifecycle schedules", () => {
  it("places bubbles from the actual target geometry rather than predicted spawn bounds", async () => {
    const f = fixture();
    const separateRead = vi.spyOn(f.bridge, "getPetMonitorWorkArea");
    vi.spyOn(f.bridge, "getPetWindowBounds").mockResolvedValue({ x: 900, y: 300, width: 180, height: 120, scaleFactor: 2, desktopScale: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
    f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    expect(f.bridge.spawnBubbleWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 915, y: 120 }));
    expect(f.bridge.getPetWindowBounds).toHaveBeenCalledWith("pet-a", f.managed.get("pet-a"));
    expect(separateRead).not.toHaveBeenCalled();
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });
  it("converts actual logical footprints before placing a bubble in physical desktop units", async () => {
    const f = fixture();
    vi.spyOn(f.bridge, "getPetWindowBounds").mockResolvedValue({ x: 2000, y: 500, width: 180, height: 120,
      scaleFactor: 2, desktopScale: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } });
    f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    expect(f.bridge.spawnBubbleWindow).toHaveBeenCalledWith(expect.objectContaining({ x: 2030, y: 140, width: 150, height: 180 }));
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });
  it("does not replay a recovered duplicate message or its animation", async () => {
    const f = fixture(); f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    const message = { id: "known", from: "a", info: "hello", created_at: "2026-10-01T00:00:00Z" };
    f.coordinator.onMessagesLoaded([message]); f.send.mockClear();
    f.coordinator.onNewMessage(message);
    expect(f.send).not.toHaveBeenCalled();
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });
  it("sends the same bounded ordered history used for later window initialization", async () => {
    const f = fixture(); f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    f.send.mockClear();
    const snapshot = Array.from({ length: 205 }, (_, index) => ({ id: String(index).padStart(3, "0"), from: "a", info: "history", created_at: "2026-10-01T00:00:00Z" })).reverse();
    f.coordinator.onMessagesLoaded(snapshot);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith("bubble-a", "pet-history", expect.objectContaining({ payload: expect.objectContaining({ messages: expect.any(Array) }) })));
    const delivered = f.send.mock.calls.find(([label, event]) => label === "bubble-a" && event === "pet-history")![2].payload.messages;
    expect(delivered).toHaveLength(200);
    expect(delivered[0].id).toBe("005"); expect(delivered.at(-1).id).toBe("204");
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });
  it("cleans a late pet creation after exit without creating its bubble", async () => {
    const f = fixture(); const started = deferred(); const finish = deferred();
    f.bridge.spawnPetWindow.mockImplementationOnce(async (options) => { started.resolve(); await finish.promise; f.managed.set(options.label, options.instanceId); });
    f.coordinator.onPresenceChange([member]); await started.promise;
    f.setRoom(null); f.coordinator.onClearRemotePets(); finish.resolve();
    await f.coordinator.whenIdle();
    expect(f.managed.size).toBe(0); expect(f.bridge.spawnBubbleWindow).not.toHaveBeenCalled();
  });
  it("waits for old destruction before recreating the same member in a new room", async () => {
    const f = fixture(); f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    const oldInstance = f.managed.get("pet-a");
    const started = deferred(); const finish = deferred();
    f.bridge.closePetWindow.mockImplementationOnce(async (label, instance) => { started.resolve(); await finish.promise; if (f.managed.get(label) === instance) f.managed.delete(label); });
    f.coordinator.onClearRemotePets(); f.setRoom("room-b"); f.coordinator.onPresenceChange([member]);
    await started.promise; expect(f.bridge.spawnPetWindow).toHaveBeenCalledTimes(1);
    finish.resolve(); await f.coordinator.whenIdle();
    expect(f.bridge.spawnPetWindow).toHaveBeenCalledTimes(2);
    expect(f.managed.get("pet-a")).not.toBe(oldInstance);
  });
  it("takes the latest identity and messages after a delayed creation instead of replaying stale data", async () => {
    const f = fixture(); const started = deferred(); const finish = deferred();
    f.bridge.spawnPetWindow.mockImplementationOnce(async (options) => { started.resolve(); await finish.promise; f.managed.set(options.label, options.instanceId); });
    f.coordinator.onPresenceChange([member]); await started.promise;
    f.coordinator.onPresenceChange([{ ...member, skin: "blue" }]);
    f.coordinator.onNewMessage({ id: "new", from: "a", info: "latest", created_at: "2026-10-01T00:00:00Z" });
    finish.resolve(); await f.coordinator.whenIdle();
    const states = f.send.mock.calls.filter((call) => call[1] === "pet-state");
    expect(states.every((call) => call[2].payload.skin === "blue")).toBe(true);
    const histories = f.send.mock.calls.filter((call) => call[1] === "pet-history");
    expect(histories.at(-1)?.[2].payload.messages[0].id).toBe("new");
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });
  it("retries resource creation after a failure instead of retaining a false ready entry", async () => {
    const f = fixture(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.bridge.spawnBubbleWindow.mockRejectedValueOnce(new Error("spawn failed"));
    f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    expect(f.managed.size).toBe(0);
    f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    expect(f.managed.size).toBe(2); expect(f.bridge.spawnPetWindow).toHaveBeenCalledTimes(2);
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle(); log.mockRestore();
  });
  it("cancels pending frontend readiness when a member goes offline", async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (label, event, payload) => { if (event !== WINDOW_READY_REQUEST) await original(label, event, payload); });
    f.coordinator.onPresenceChange([member]);
    await vi.waitFor(() => expect(f.bridge.spawnBubbleWindow).toHaveBeenCalledOnce());
    f.coordinator.onPresenceChange([]);
    await f.coordinator.whenIdle();
    expect(f.managed.size).toBe(0);
  });
  it("does not let a delayed free-mode layout overwrite the latest semi-mode layout", async () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "pet-pos:room-a:a" ? JSON.stringify({ x: 800, y: 500 }) : null,
      setItem: () => {}, removeItem: () => {} });
    const f = fixture();
    f.coordinator.onPresenceChange([member]); await f.coordinator.whenIdle();
    f.coordinator.setMode("semi"); await f.coordinator.whenIdle();
    const started = deferred(); const finish = deferred<Array<{ x: number; y: number; width: number; height: number }>>();
    vi.spyOn(f.bridge, "getMonitors").mockImplementationOnce(async () => { started.resolve(); return finish.promise; });
    f.coordinator.setMode("free"); await started.promise;
    f.coordinator.setMode("semi"); finish.resolve([{ x: 0, y: 0, width: 1920, height: 1080 }]);
    await f.coordinator.whenIdle();
    const arrangements = f.send.mock.calls.filter((call) => call[1] === "pet-arrange");
    expect(arrangements.at(-1)?.[2].payload.x).not.toBe(800);
    f.setRoom(null); f.coordinator.onClearRemotePets(); await f.coordinator.whenIdle();
  });

});
