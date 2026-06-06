import "./styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initConnectPanel, openConnectPanel } from "./connect.js";
import { createAppSupabaseClient } from "./supabaseClient.js";

const supabase = createAppSupabaseClient();

async function init() {
  const { data } = await supabase.auth.getSession();
  const selfAuthId = data.session?.user?.id || null;

  initConnectPanel({
    supabase,
    selfAuthId,
    onEnterRoom: (roomId) => {
      getCurrentWindow().hide();
      emit("switch-room", { roomId });
    },
  });

  openConnectPanel();

  // 重新从 tray 打开时刷新数据
  listen("connect-refresh", () => openConnectPanel());
}

init().catch(console.error);
