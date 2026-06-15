import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLoungePanel, openLoungePanel, refreshLoungePanelActiveRoom, updateLoungePanelAuth } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

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

async function init() {
  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    getActiveRoomId: () => activeRoomId,
    onEnterRoom: (roomId: string) => {
      void emit("lounge-hidden");
      void getCurrentWindow().hide();
      void emit("switch-room", { roomId });
    },
    onExitRoom: () => {
      void emit("exit-room");
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
    updateLoungePanelAuth({ supabase, selfAuthId: session?.user?.id || null });
  });

  listen("lounge-refresh", () => {
    void emit("request-active-room");
    openLoungePanel();
  });

  listen<{ roomId?: string | null }>("active-room-changed", (event) => {
    activeRoomId = event.payload?.roomId || null;
    refreshLoungePanelActiveRoom();
  });

  openLoungePanel();

  if (selfAuthId) {
    void emit("request-active-room");
  }

  initDragRegion();
  initResizeHandle();
}

init().catch(console.error);
