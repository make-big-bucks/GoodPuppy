import "../../shared/styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLoungePanel, openLoungePanel } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

const supabase = createAppSupabaseClient();

async function init() {
  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    onEnterRoom: (roomId) => {
      getCurrentWindow().hide();
      emit("switch-room", { roomId });
    },
  });

  openLoungePanel();

  // 重新从 tray 打开时刷新数据
  listen("lounge-refresh", () => openLoungePanel());
}

init().catch(console.error);
