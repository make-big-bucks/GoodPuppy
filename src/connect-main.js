import "./styles.css";
import { createClient } from "@supabase/supabase-js";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appConfig from "./appConfig.js";
import { initConnectPanel, openConnectPanel } from "./connect.js";

const supabase = createClient(appConfig.supabase.url, appConfig.supabase.apiKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

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
