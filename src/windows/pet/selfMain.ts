// 自己窗口（label "main"）入口：启动鉴权/房间恢复，并把 Lounge 的进/出房间、
// 退出握手等控制事件接到 renderer（自己 pet 呈现 + 房间协调者）。
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exitCurrentRoom, getCurrentRoomId, startPetApp, switchRoom, setOnRoomReadyCallback, setSelfSkin, prepareSelfForRoom } from "./renderer.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";
import { createRoomVisibilityController } from "./roomVisibility.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const supabase = createAppSupabaseClient();

async function startFromStoredSession() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    startPetApp({ supabase, session: data.session });
  }
}

if (inTauri) {
  const visibility = createRoomVisibilityController({
    getRoomId: getCurrentRoomId,
    prepare: prepareSelfForRoom,
    setVisible: (visible) => visible ? getCurrentWindow().show() : getCurrentWindow().hide(),
    notify: (roomId) => emit("active-room-changed", { roomId }),
  });
  setOnRoomReadyCallback(() => {
    void visibility.sync().catch(console.error);
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
    await visibility.sync();
  });

  listen("exit-room", async () => {
    await exitCurrentRoom();
    await visibility.sync();
  });

  // 会客厅资料卡换肤面板「保存」后广播：应用到自己 pet（动画 + presence 通道 A）。
  listen<{ skin?: string | null }>("set-skin", (event) => {
    setSelfSkin(event.payload?.skin);
  });

  // 退出前清理 presence，完成后通知 Rust 可以 exit（握手）。
  // 崩溃/强杀场景由 lounge 的 last_seen 时间阈值兜底。
  listen("app-before-quit", async () => {
    await exitCurrentRoom().catch(console.error);
    emit("app-quit-ready", null);
  });
}
