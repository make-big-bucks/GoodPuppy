// 自己窗口（label "main"）入口：启动鉴权/房间恢复，并把 Lounge 的进/出房间、
// 退出握手等控制事件接到 renderer（自己 pet 呈现 + 房间协调者）。
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exitCurrentRoom, getCurrentRoomId, getRoomRevision, startPetApp, stopPetApp, switchRoom, setOnRoomReadyCallback, setSelfSkin, prepareSelfForRoom } from "./renderer.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";
import { createRoomVisibilityController } from "./roomVisibility.js";

import { ROOM_COMMAND, ROOM_CANCEL, ROOM_RESULT, executeRoomCommand, isRoomCommand } from "../../shared/roomProtocol.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const supabase = createAppSupabaseClient();

async function startFromStoredSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;

  if (data.session) {
    await startPetApp({ supabase, session: data.session });
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

  listen("pet-init", () => void startFromStoredSession().catch(console.error));
  listen("auth-cleared", () => void stopPetApp().catch(console.error));
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") void stopPetApp().catch(console.error);
    else if (event === "SIGNED_IN" && session) {
      void startPetApp({ supabase, session }).catch(console.error);
    }
  });

  startFromStoredSession().catch((error) => {
    console.error(error);
  });

  listen("request-active-room", () => {
    emit("active-room-changed", { roomId: getCurrentRoomId() });
  });

  let latestRequest: string | null = null;
  window.goodPuppy.onAppEvent(ROOM_COMMAND, (payload) => {
    if (!isRoomCommand(payload)) return;
    latestRequest = payload.requestId;
    void executeRoomCommand(payload, {
      enter: async (roomId) => { await startFromStoredSession(); await switchRoom(roomId); },
      exit: exitCurrentRoom,
      sync: () => visibility.sync(),
      getRoomId: getCurrentRoomId,
      getRevision: getRoomRevision,
    }).then(async (result) => {
      if (latestRequest === payload.requestId) latestRequest = null;
      await window.goodPuppy.emitToWindow(payload.replyTo, ROOM_RESULT, result);
    }).catch(console.error);
  });

  window.goodPuppy.onAppEvent<{ requestId?: string }>(ROOM_CANCEL, (payload) => {
    if (payload?.requestId !== latestRequest) return;
    latestRequest = null;
    void exitCurrentRoom().finally(() => visibility.sync()).catch(console.error);
  });

  // 自己的右键菜单只有退出操作，不参与会客厅请求回执。
  listen("exit-room", () => {
    void exitCurrentRoom().finally(() => visibility.sync()).catch(console.error);
  });

  // 会客厅资料卡换肤面板「保存」后广播：应用到自己 pet（动画 + presence 通道 A）。
  listen<{ skin?: string | null }>("set-skin", (event) => {
    setSelfSkin(event.payload?.skin);
  });

  // 退出前清理 presence，完成后通知 Rust 可以 exit（握手）。
  // 崩溃/强杀场景由 lounge 的 last_seen 时间阈值兜底。
  listen("app-before-quit", async () => {
    await exitCurrentRoom({ rememberRoom: true }).catch(console.error);
    emit("app-quit-ready", null);
  });
}
