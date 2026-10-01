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

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

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
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

import { ROOM_COMMAND, ROOM_CANCEL, ROOM_RESULT, type RoomResult } from "../../shared/roomProtocol.js";
import { requestWindow } from "../../shared/windowRequest.js";

const supabase = createAppSupabaseClient();
let activeRoomId: string | null = null;

function sessionIsAnonymous(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
  return Boolean(session?.user?.is_anonymous);
}

let requests = new AbortController();
async function changeRoom(action: "enter" | "exit", roomId?: string) {
  const result = await requestWindow<RoomResult>({
    listen: (event, handler) => window.goodPuppy.onAppEvent(event, handler),
    send: (target, event, payload) => window.goodPuppy.emitToWindow(target, event, payload),
  }, {
    target: "main", requestEvent: ROOM_COMMAND, responseEvent: ROOM_RESULT,
    payload: { action, roomId, replyTo: "lounge" }, signal: requests.signal, cancelEvent: ROOM_CANCEL,
  });
  if (result.action !== action || result.requestedRoomId !== roomId
    || result.roomId !== (action === "enter" ? roomId : null)) throw new Error("房间回复与请求不一致");
  activeRoomId = result.roomId;
  refreshLoungePanelActiveRoom();
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
      activeRoomId = null;
    },
    onSkinSaved: (skin: string, userId: string) => {
      void window.goodPuppy.emitToWindow("main", "set-skin", { skin, userId }).catch(console.error);
    },
  });

  let authenticatedUserId = selfAuthId;
  // 认证状态变化时同步更新会客厅（跳过初次 INITIAL_SESSION，已由 getSession 处理）
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION") return;
    const nextUserId = session?.user.id ?? null;
    if (nextUserId !== authenticatedUserId) {
      requests.abort();
      requests = new AbortController();
      activeRoomId = null;
      authenticatedUserId = nextUserId;
    }
    updateLoungePanelAuth({
      supabase,
      selfAuthId: session?.user?.id || null,
      isAnonymous: sessionIsAnonymous(session),
      email: session?.user?.email ?? null,
    });
  });

  listen("lounge-refresh", () => {
    void emit("request-active-room");
    openLoungePanel();
  });

  // 托盘右键「房间聊天记录」：打开当前房间聊天记录。
  listen("open-room-history", () => {
    void emit("request-active-room");
    openLoungePanel();
    void openActiveRoomHistory();
  });

  listen<{ roomId?: string | null }>("active-room-changed", (event) => {
    activeRoomId = event.payload?.roomId || null;

    refreshLoungePanelActiveRoom();
  });

  openLoungePanel();

  if (selfAuthId) {
    void emit("request-active-room");
  }

  await initWinTitlebar();
  initDragRegion();
  initResizeHandle();
}

init().catch(console.error);
