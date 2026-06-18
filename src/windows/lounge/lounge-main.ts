import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { initLoungePanel, openLoungePanel, refreshLoungePanelActiveRoom, updateLoungePanelAuth } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

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
    window.goodPuppy.startWindowDrag();
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
    window.goodPuppy.startWindowDrag();
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

const supabase = createAppSupabaseClient();
let activeRoomId: string | null = null;

function sessionIsAnonymous(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
  return Boolean(session?.user?.is_anonymous);
}

// Deferred resolvers for room transition promises
let pendingEnterResolve: (() => void) | null = null;
let pendingExitResolve: (() => void) | null = null;

async function init() {
  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    isAnonymous: sessionIsAnonymous(data.session),
    getActiveRoomId: () => activeRoomId,
    onEnterRoom: (roomId: string) => {
      void emit("switch-room", { roomId });
      return new Promise<void>((resolve) => {
        pendingEnterResolve = resolve;
      });
    },
    onExitRoom: () => {
      void emit("exit-room");
      return new Promise<void>((resolve) => {
        pendingExitResolve = resolve;
      });
    },
    onLoginSuccess: () => {
      void emit("auth-ready");
    },
    onLogout: () => {
      void emit("auth-cleared");
      activeRoomId = null;
    },
  });

  // 认证状态变化时同步更新会客厅（跳过初次 INITIAL_SESSION，已由 getSession 处理）
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION") return;
    updateLoungePanelAuth({
      supabase,
      selfAuthId: session?.user?.id || null,
      isAnonymous: sessionIsAnonymous(session),
    });
  });

  listen("lounge-refresh", () => {
    void emit("request-active-room");
    openLoungePanel();
  });

  listen<{ roomId?: string | null }>("active-room-changed", (event) => {
    activeRoomId = event.payload?.roomId || null;

    if (activeRoomId && pendingEnterResolve) {
      // Room entry confirmed: resolve promise, then hide lounge
      const resolve = pendingEnterResolve;
      pendingEnterResolve = null;
      resolve();
      void emit("lounge-hidden");
      void getCurrentWindow().hide();
      // lounge.ts handleRoomTransition will call renderAll after resolve
    } else if (!activeRoomId && pendingExitResolve) {
      // Room exit confirmed: resolve promise
      const resolve = pendingExitResolve;
      pendingExitResolve = null;
      resolve();
      // lounge.ts handleRoomTransition will call renderAll after resolve
    } else {
      // No pending transition — refresh normally (e.g. request-active-room response)
      refreshLoungePanelActiveRoom();
    }
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
