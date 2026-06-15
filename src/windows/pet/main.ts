import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exitCurrentRoom, getCurrentRoomId, startPetApp, switchRoom, setOnRoomReadyCallback } from "./renderer.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const supabase = createAppSupabaseClient();

async function startFromStoredSession() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    startPetApp({ supabase, session: data.session });
  }
}

if (inTauri) {
  setOnRoomReadyCallback(() => {
    if (getCurrentRoomId()) {
      void getCurrentWindow().show();
    } else {
      void getCurrentWindow().hide();
    }
    // 通知 Lounge 同步房间状态（解决自动恢复时 Lounge 未收到通知的时序问题）
    void emit("active-room-changed", { roomId: getCurrentRoomId() });
  });

  listen("pet-init", startFromStoredSession);

  startFromStoredSession().catch((error) => {
    console.error(error);
  });

  listen("request-active-room", () => {
    emit("active-room-changed", { roomId: getCurrentRoomId() });
  });

  listen<{ roomId?: string | null }>("switch-room", async (event) => {
    if (!event.payload.roomId) return;
    await switchRoom(event.payload.roomId);
    void getCurrentWindow().show();
    emit("active-room-changed", { roomId: getCurrentRoomId() });
  });

  listen("exit-room", async () => {
    await exitCurrentRoom();
    void getCurrentWindow().hide();
    emit("active-room-changed", { roomId: getCurrentRoomId() });
  });

  // 退出前清理 presence，完成后通知 Rust 可以 exit（握手）。
  // 崩溃/强杀场景由 lounge 的 last_seen 时间阈值兜底。
  listen("app-before-quit", async () => {
    await exitCurrentRoom().catch(console.error);
    emit("app-quit-ready", null);
  });
}
