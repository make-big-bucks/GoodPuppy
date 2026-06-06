// 顺序重要：bridge 必须先于 renderer 执行（renderer 顶层会读 window.goodPuppy）
import "./bridge.js";
import "./styles.css";
import { createClient } from "@supabase/supabase-js";
import { listen, emit } from "@tauri-apps/api/event";
import appConfig from "./appConfig.js";
import { startPetApp, switchRoom } from "./renderer.js";

const supabase = createClient(appConfig.supabase.url, appConfig.supabase.apiKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Rust 确认窗口已显示后触发，从 localStorage 读取已有 session 启动 Pet
listen("pet-init", async () => {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    startPetApp({ supabase, session: data.session });
  }
});

// 连接管理窗口通知切换房间
listen("switch-room", (event) => {
  switchRoom(event.payload.roomId);
});

// tray 退出登录
listen("auth-logout-requested", async () => {
  await supabase.auth.signOut();
  emit("auth-cleared");
});
