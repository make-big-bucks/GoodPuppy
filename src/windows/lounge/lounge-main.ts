import { requestRoomState, isRoomState, type RoomState } from "../../shared/roomState.js";
import { showToast } from "./views/toast.js";
import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { initLoungePanel, openActiveRoomHistory, openLoungePanel, refreshLoungePanelActiveRoom, updateLoungePanelAuth } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";
import appConfig from "../../shared/appConfig.js";
import { getSupabaseStorageKey } from "../../shared/backendConfig.js";
import { showPanelSkeleton, hidePanelState } from "./views/panelState.js";

// 是否存在已持久化的登录态。Supabase 把 session 存在 localStorage 的
// `sb-<ref>-auth-token` 键里，这里同步探测，用于在 await getSession() 之前就决定
// 要不要先铺骨架屏（已登录用户冷启动几乎必然有这个键）。
function hasPersistedSession(): boolean {
  try {
    return Boolean(localStorage.getItem(getSupabaseStorageKey(appConfig.supabase)));
  } catch {
    /* localStorage 不可用时按未登录处理 */
  }
  return false;
}

async function initWinTitlebar() {
  if (!navigator.platform.startsWith('Win')) return;

  document.body.classList.add('platform-windows');

  // Attach the title bar controls FIRST, synchronously, so they are wired up
  // regardless of how the sizing/show IPC below resolves. (Previously these were
  // attached after the awaits, so a rejected/deferred resize left the title bar
  // visible but undraggable.)
  const dragArea = document.querySelector('.win-titlebar-drag') as HTMLElement | null;
  const minBtn = document.querySelector('.win-minimize-btn') as HTMLButtonElement | null;
  const maxBtn = document.querySelector('.win-maximize-btn') as HTMLButtonElement | null;
  const closeBtn = document.querySelector('.win-close-btn') as HTMLButtonElement | null;

  dragArea?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    void window.goodPuppy.startWindowDrag().catch(console.error);
  });

  minBtn?.addEventListener('click', () => {
    void getCurrentWindow().minimize();
  });

  maxBtn?.addEventListener('click', () => {
    void getCurrentWindow().toggleMaximize();
  });

  closeBtn?.addEventListener('click', () => {
    void getCurrentWindow().hide();
  });

  // Rust stripped decorations while the window was hidden. Now resize to compensate
  // for the 28px custom title bar so the app content area matches macOS (720px),
  // then show the window — no flash since it was never visible before this point.
  // Done last (and defensively) so a sizing failure can never block the controls
  // above or leave the window stuck hidden.
  const appWindow = getCurrentWindow();
  try {
    await appWindow.setSize(new LogicalSize(1120, 748));
    await appWindow.setMinSize(new LogicalSize(1040, 708));
  } catch (error) {
    console.warn('Failed to resize lounge window for custom title bar.', error);
  }
  await appWindow.show();
}

function initDragRegion() {
  const dragRegion = document.querySelector(".sidebar-drag-region") as HTMLElement | null;
  if (!dragRegion) return;
  dragRegion.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    void window.goodPuppy.startWindowDrag().catch(console.error);
  });
}

function initResizeHandle() {
  const handle = document.querySelector(".resize-handle") as HTMLElement | null;
  const appWindow = document.querySelector(".app-window") as HTMLElement | null;
  if (!handle || !appWindow) return;

  const MIN_W = 240;
  const MAX_W = 480;

  let stopResize: (() => void) | null = null;
  window.addEventListener("beforeunload", () => stopResize?.(), { once: true });

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stopResize?.();
    const events = new AbortController();

    const startX = e.clientX;
    const startW = (document.querySelector(".sidebar") as HTMLElement).offsetWidth;
    handle.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
      appWindow.style.setProperty("--sidebar-w", `${newW}px`);
    };

    const onUp = () => {
      handle.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      events.abort();
      stopResize = null;
    };

    stopResize = onUp;
    window.addEventListener("mousemove", onMove, { signal: events.signal });
    window.addEventListener("mouseup", onUp, { signal: events.signal });
    // 切应用/隐藏窗口可能收不到 mouseup，必须释放拖动样式和监听。
    window.addEventListener("blur", onUp, { signal: events.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") onUp();
    }, { signal: events.signal });
  });
}

import { ROOM_COMMAND, ROOM_CANCEL, ROOM_RESULT, type RoomResult } from "../../shared/roomProtocol.js";
import { requestWindow } from "../../shared/windowRequest.js";

const supabase = createAppSupabaseClient();
let activeRoomId: string | null = null;
let authenticatedUserId: string | null = null;
let activeRoomRevision = -1;
let activeRoomController: string | null = null;
let roomReadGeneration = 0;
let latestRoomRead: Promise<void> = Promise.resolve();

function sessionIsAnonymous(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
  return Boolean(session?.user?.is_anonymous);
}

let requests = new AbortController();
function applyRoomState(state: RoomState, queried = false) {
  if (state.userId !== authenticatedUserId) return;
  if (state.controllerId !== activeRoomController) {
    if (!queried) { void synchronizeActiveRoom().catch(reportStateError); return; }
    activeRoomController = state.controllerId; activeRoomRevision = -1;
  }
  if (state.revision < activeRoomRevision) return;
  activeRoomRevision = state.revision; activeRoomId = state.roomId;
  refreshLoungePanelActiveRoom();
}
function synchronizeActiveRoom(): Promise<void> {
  const userId = authenticatedUserId; const signal = requests.signal; const generation = ++roomReadGeneration;
  const assertCurrent = () => {
    if (signal.aborted || userId !== authenticatedUserId) throw new DOMException("房间查询已失效", "AbortError");
  };
  const result = (async () => {
    try {
      const state = await requestRoomState({
        listen: (event, handler) => window.goodPuppy.onAppEvent(event, handler),
        send: (target, event, payload) => window.goodPuppy.emitToWindow(target, event, payload),
      }, userId, signal);
      assertCurrent();
      if (generation !== roomReadGeneration) { await latestRoomRead; assertCurrent(); return; }
      applyRoomState(state, true);
    } catch (error) {
      assertCurrent();
      if (generation !== roomReadGeneration) { await latestRoomRead; assertCurrent(); return; }
      throw error;
    }
  })();
  latestRoomRead = result;
  return result;
}

function reportStateError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  showToast(error instanceof Error ? error.message : "读取房间状态失败", "error");
}

async function changeRoom(action: "enter" | "exit", roomId?: string) {
  const signal = requests.signal; const userId = authenticatedUserId;
  const assertCurrent = () => { if (signal.aborted || userId !== authenticatedUserId) throw new DOMException("账号已改变", "AbortError"); };
  const result = await requestWindow<RoomResult>({
    listen: (event, handler) => window.goodPuppy.onAppEvent(event, handler),
    send: (target, event, payload) => window.goodPuppy.emitToWindow(target, event, payload),
  }, {
    target: "main", requestEvent: ROOM_COMMAND, responseEvent: ROOM_RESULT,
    payload: { action, roomId, replyTo: "lounge" }, signal, cancelEvent: ROOM_CANCEL,
  });
  if (result.action !== action || result.requestedRoomId !== roomId
    || result.roomId !== (action === "enter" ? roomId : null)) throw new Error("房间回复与请求不一致");
  assertCurrent();
  await synchronizeActiveRoom();
  assertCurrent();
  if (activeRoomId !== result.roomId) throw new Error("房间状态已发生变化，请重试");
  if (action === "enter") {
    await getCurrentWindow().hide();
    await emit("lounge-hidden");
  }
}

async function init() {
  // 冷启动先铺骨架屏，避免在 await getSession()（多窗口共享 auth 锁时可能较慢）期间
  // 露出尚未加载数据的静态页面。若实际未登录，下面 openLoungePanel 的非登录分支会撤掉。
  if (hasPersistedSession()) showPanelSkeleton();

  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    isAnonymous: sessionIsAnonymous(data.session),
    email: data.session?.user?.email ?? null,
    getActiveRoomId: () => activeRoomId,
    onEnterRoom: (roomId: string) => changeRoom("enter", roomId),
    onExitRoom: () => changeRoom("exit"),
    onLoginSuccess: () => {
      void emit("auth-ready");
    },
    onLogout: () => {
      requests.abort();
      requests = new AbortController();
      void emit("auth-cleared");
      activeRoomId = null; activeRoomRevision = -1; activeRoomController = null;
    },
    onSkinSaved: (skin: string, userId: string) => {
      void window.goodPuppy.emitToWindow("main", "set-skin", { skin, userId }).catch(console.error);
    },
  });

  authenticatedUserId = selfAuthId;
  // INITIAL_SESSION 也参与身份同步，重复会话由上下文比较消除。
  supabase.auth.onAuthStateChange((_event, session) => {
    const nextUserId = session?.user.id ?? null;
    if (nextUserId !== authenticatedUserId) {
      requests.abort();
      requests = new AbortController();
      activeRoomId = null; activeRoomRevision = -1; activeRoomController = null;
      authenticatedUserId = nextUserId;
      void synchronizeActiveRoom().catch(reportStateError);
    }
    updateLoungePanelAuth({
      supabase,
      selfAuthId: session?.user?.id || null,
      isAnonymous: sessionIsAnonymous(session),
      email: session?.user?.email ?? null,
    });
  });

  listen("lounge-refresh", () => {
    openLoungePanel();
    void synchronizeActiveRoom().catch(reportStateError);
  });

  listen("open-room-history", () => {
    openLoungePanel();
    const signal = requests.signal; const userId = authenticatedUserId;
    void synchronizeActiveRoom().then(() => {
      if (signal.aborted || userId !== authenticatedUserId) throw new DOMException("账号已改变", "AbortError");
      return openActiveRoomHistory();
    }).catch(reportStateError);
  });

  listen<RoomState>("active-room-changed", (event) => {
    if (isRoomState(event.payload)) applyRoomState(event.payload);
  });

  openLoungePanel();

  if (selfAuthId) {
    void synchronizeActiveRoom().catch(reportStateError);
  }

  await initWinTitlebar();
  initDragRegion();
  initResizeHandle();
}

init().catch(console.error);
