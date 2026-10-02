import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), unsubscribe: vi.fn(), resume: vi.fn(),
  getSession: vi.fn(), auth: vi.fn(),
}));
vi.mock("../../shared/supabaseClient.js", () => ({ createAppSupabaseClient: () => ({ auth: {
  getSession: mocks.getSession, onAuthStateChange: mocks.auth,
} }) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("../../shared/resumeMonitor.js", () => ({ createResumeMonitor: () => mocks.resume }));
vi.mock("./roomManager.js", () => ({ recoverRoomAfterResume: vi.fn(), getSelfAuthId: () => null }));
vi.mock("./renderer.js", () => ({
  startPetApp: mocks.start, stopPetApp: mocks.stop, exitCurrentRoom: vi.fn(),
  getCurrentRoomId: () => null, getRoomRevision: () => 0, switchRoom: vi.fn(),
  setOnRoomStateChangedCallback: vi.fn(), setSelfSkin: vi.fn(), prepareSelfForRoom: vi.fn(), setSelfPresentationVisible: vi.fn(),
}));

it("unloading main releases subscriptions and rejects a late session bootstrap", async () => {
  let resolveSession!: (value: unknown) => void;
  mocks.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
  let authCallback!: (event: string, session: unknown) => void;
  mocks.auth.mockImplementation((callback) => { authCallback = callback; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; });
  const page = new EventTarget();
  const releases: ReturnType<typeof vi.fn>[] = [];
  vi.stubGlobal("window", Object.assign(page, { __TAURI_INTERNALS__: {}, goodPuppy: {
    onAppEvent: () => { const release = vi.fn(); releases.push(release); return release; },
  } }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("./selfMain.js");
    page.dispatchEvent(new Event("beforeunload"));
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce(); expect(mocks.resume).toHaveBeenCalledOnce();
    authCallback("SIGNED_IN", { user: { id: "late-user" } });
    resolveSession({ data: { session: { user: { id: "late-user" } } }, error: null });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
  } finally { errors.mockRestore(); vi.unstubAllGlobals(); }
});
