import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLoungePanel, openLoungePanel } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

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
      void getCurrentWindow().hide();
      void emit("switch-room", { roomId });
    },
    onExitRoom: () => emit("exit-room"),
  });

  listen("lounge-refresh", () => {
    void emit("request-active-room");
    openLoungePanel();
  });

  listen<{ roomId?: string | null }>("active-room-changed", (event) => {
    activeRoomId = event.payload?.roomId || null;
    openLoungePanel();
  });

  openLoungePanel();
  await emit("request-active-room");
}

init().catch(console.error);
