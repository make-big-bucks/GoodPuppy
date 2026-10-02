import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), context: vi.fn(), dispose: vi.fn(), monitor: vi.fn(), openHistory: vi.fn(), closeHistory: vi.fn() }));
vi.mock("./loungeData.js", () => ({ fetchLoungeData: mocks.fetch }));
vi.mock("./loungeSubscriptions.js", () => ({ createLoungeSubscriptions: () => ({ setContext: mocks.context, dispose: mocks.dispose }) }));
vi.mock("../../shared/resumeMonitor.js", () => ({ createResumeMonitor: () => mocks.monitor }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("./onlineNotifier.js", () => ({ initOnlineNotifier: vi.fn(), disposeOnlineNotifier: vi.fn() }));
vi.mock("./views/chat-history-dialog.js", () => ({ openChatHistory: mocks.openHistory, closeChatHistory: mocks.closeHistory }));
vi.mock("./views/settings.js", () => ({ closeSettings: vi.fn() }));
vi.mock("./views/pet-showcase.js", () => ({ closeShowcase: vi.fn() }));
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
