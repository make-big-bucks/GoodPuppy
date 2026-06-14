import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLoungePanel, openLoungePanel } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

const supabase = createAppSupabaseClient();
let activeRoomId = null;

async function init() {
  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    getActiveRoomId: () => activeRoomId,
    onEnterRoom: (roomId) => {
      getCurrentWindow().hide();
      emit("switch-room", { roomId });
    },
    onExitRoom: () => emit("exit-room"),
  });

  // 重新从 tray 打开时刷新数据
  listen("lounge-refresh", () => {
    emit("request-active-room");
    openLoungePanel();
  });

  listen("active-room-changed", (event) => {
    activeRoomId = event.payload?.roomId || null;
    openLoungePanel();
  });

  openLoungePanel();
  emit("request-active-room");
}

init().catch(console.error);
