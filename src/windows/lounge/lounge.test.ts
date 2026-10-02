import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), context: vi.fn(), dispose: vi.fn(), monitor: vi.fn(), openHistory: vi.fn(), closeHistory: vi.fn(), closeSettings: vi.fn(), closeShowcase: vi.fn() }));
vi.mock("./loungeData.js", () => ({ fetchLoungeData: mocks.fetch }));
vi.mock("./loungeSubscriptions.js", () => ({ createLoungeSubscriptions: () => ({ setContext: mocks.context, dispose: mocks.dispose }) }));
vi.mock("../../shared/resumeMonitor.js", () => ({ createResumeMonitor: () => mocks.monitor }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("./onlineNotifier.js", () => ({ initOnlineNotifier: vi.fn(), disposeOnlineNotifier: vi.fn(), isRoomSubscribed: vi.fn() }));
vi.mock("./views/chat-history-dialog.js", () => ({ openChatHistory: mocks.openHistory, closeChatHistory: mocks.closeHistory }));
vi.mock("./views/settings.js", () => ({ closeSettings: mocks.closeSettings }));
vi.mock("./views/pet-showcase.js", () => ({ closeShowcase: mocks.closeShowcase }));
vi.mock("./views/panelState.js", () => ({ showPanelSkeleton: vi.fn() }));
vi.mock("./views/room-list.js", () => ({ renderRoomList: vi.fn(), renderPendingRequests: vi.fn() }));
vi.mock("./views/room-detail.js", () => ({ renderRoomDetail: vi.fn() }));
vi.mock("./views/profile-card.js", () => ({ renderProfileCard: vi.fn() }));

it("unload cancels pending history and releases remaining resources after a cleanup failure", async () => {
  let finish!: () => void;
  mocks.fetch.mockReturnValue(new Promise(resolve => { finish = () => resolve({}); }));
  mocks.dispose.mockImplementation(() => { throw new Error("channel cleanup failed"); });
  const page = new EventTarget(); const release = vi.fn();
  vi.stubGlobal("window", Object.assign(page, { goodPuppy: { onAppEvent: () => release } }));
  vi.stubGlobal("document", { querySelector: () => null });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const lounge = await import("./lounge.js");
    const options = { supabase: {} as never, selfAuthId: "user", isAnonymous: false, email: null,
      getActiveRoomId: () => "room", onEnterRoom: vi.fn(), onExitRoom: vi.fn(), onLoginSuccess: vi.fn(), onLogout: vi.fn(), onSkinSaved: vi.fn() };
    lounge.initLoungePanel(options);
    const history = expect(lounge.openActiveRoomHistory()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    page.dispatchEvent(new Event("beforeunload")); finish(); await history;
    expect(mocks.openHistory).not.toHaveBeenCalled(); expect(mocks.closeHistory).toHaveBeenCalledOnce();
    expect(mocks.monitor).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalled();
    mocks.context.mockClear(); lounge.updateLoungePanelAuth({ ...options, selfAuthId: "other" });
    expect(mocks.context).not.toHaveBeenCalled();
  } finally { errors.mockRestore(); vi.unstubAllGlobals(); }
});

it.each(["user", "client"])("replaces %s ownership without allowing pending history to open an old dialog", async (change) => {
  vi.resetModules(); vi.clearAllMocks(); mocks.dispose.mockReset();
  const finishes: (() => void)[] = [];
  mocks.fetch.mockImplementation(() => new Promise(resolve => { finishes.push(() => resolve({})); }));
  const page = new EventTarget();
  vi.stubGlobal("window", Object.assign(page, { goodPuppy: { onAppEvent: () => vi.fn() } }));
  vi.stubGlobal("document", { querySelector: () => null });
  try {
    const lounge = await import("./lounge.js");
    const client = {} as never;
    const options = { supabase: client, selfAuthId: "user", isAnonymous: false, email: null,
      getActiveRoomId: () => "room", onEnterRoom: vi.fn(), onExitRoom: vi.fn(), onLoginSuccess: vi.fn(), onLogout: vi.fn(), onSkinSaved: vi.fn() };
    lounge.initLoungePanel(options);
    const old = expect(lounge.openActiveRoomHistory()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const next = { supabase: change === "client" ? {} as never : client, selfAuthId: change === "user" ? "other" : "user", isAnonymous: false, email: null };
    lounge.updateLoungePanelAuth(next);
    expect(mocks.closeHistory).toHaveBeenCalledOnce(); expect(mocks.closeSettings).toHaveBeenCalledOnce(); expect(mocks.closeShowcase).toHaveBeenCalledOnce();
    expect(mocks.context).toHaveBeenLastCalledWith({ client: next.supabase, userId: next.selfAuthId });
    finishes[0](); await old;
    expect(mocks.openHistory).not.toHaveBeenCalled();
    page.dispatchEvent(new Event("beforeunload")); for (const finish of finishes) finish();
  } finally { page.dispatchEvent(new Event("beforeunload")); vi.unstubAllGlobals(); }
});
