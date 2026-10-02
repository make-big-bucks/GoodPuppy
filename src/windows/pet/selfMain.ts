import { ROOM_STATE_QUERY, ROOM_STATE_RESULT, isRoomStateRequest, type RoomState } from "../../shared/roomState.js";
// 自己窗口（label "main"）入口：启动鉴权/房间恢复，并把 Lounge 的进/出房间、
// 退出握手等控制事件接到 renderer（自己 pet 呈现 + 房间协调者）。
import { emit } from "@tauri-apps/api/event";
import { exitCurrentRoom, getCurrentRoomId, getRoomRevision, startPetApp, stopPetApp, switchRoom, setOnRoomStateChangedCallback, setSelfSkin, prepareSelfForRoom, setSelfPresentationVisible } from "./renderer.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";
import { createRoomVisibilityController } from "./roomVisibility.js";
import { createResumeMonitor } from "../../shared/resumeMonitor.js";
import { recoverRoomAfterResume, getSelfAuthId } from "./roomManager.js";
import { isOwnSkinUpdate } from "../../shared/pet/petWindowEvents.js";
import { createResourceLifetime } from "../../shared/resourceLifetime.js";
import { recordLifecycle } from "../../shared/diagnostics.js";

import { ROOM_COMMAND, ROOM_CANCEL, ROOM_RESULT, executeRoomCommand, isRoomCommand } from "../../shared/roomProtocol.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const supabase = createAppSupabaseClient();
const page = createResourceLifetime();
function assertPageActive() {
  if (page.signal.aborted) throw new DOMException("主窗口已关闭", "AbortError");
}
function listenPage<T = unknown>(event: string, handler: (payload: T) => void) {
  page.own(window.goodPuppy.onAppEvent<T>(event, (payload) => { if (!page.signal.aborted) handler(payload); }));
}
window.addEventListener("beforeunload", () => page.dispose(), { once: true });

async function startFromStoredSession() {
  const { data, error } = await supabase.auth.getSession();
  assertPageActive();
  if (error) throw error;

  if (data.session) {
    await startPetApp({ supabase, session: data.session });
  } else if (getSelfAuthId()) await stopPetApp();
}

function roomState(): RoomState { return { controllerId: window.goodPuppy.getWindowInstance(), roomId: getCurrentRoomId(), userId: getSelfAuthId(), revision: getRoomRevision() }; }

if (inTauri) {
  const disposeResumeMonitor = createResumeMonitor(recoverRoomAfterResume);
  page.own(disposeResumeMonitor);
  const visibility = createRoomVisibilityController({
    getRoomId: getCurrentRoomId,
    prepare: prepareSelfForRoom,
    setVisible: async (visible) => {
      assertPageActive();
      await window.goodPuppy.setSelfVisible(visible);
      if (!page.signal.aborted) setSelfPresentationVisible(visible);
    },
    notify: () => page.signal.aborted ? Promise.resolve() : emit("active-room-changed", roomState()),
  });
  setOnRoomStateChangedCallback(() => {
    if (!page.signal.aborted) void visibility.sync().catch(console.error);
  });

  listenPage("pet-init", () => void startFromStoredSession().catch(console.error));
  listenPage("auth-cleared", () => void stopPetApp().catch(console.error));
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (page.signal.aborted) return;
    if (event === "SIGNED_OUT") void stopPetApp().catch(console.error);
    else if (event === "SIGNED_IN" && session) {
      void startPetApp({ supabase, session }).catch(console.error);
    }
  });

  page.own(() => subscription.unsubscribe());

  startFromStoredSession().catch((error) => {
    console.error(error);
  });

  listenPage("request-active-room", () => {
    emit("active-room-changed", roomState());
  });

  listenPage(ROOM_STATE_QUERY, (payload) => {
    if (!isRoomStateRequest(payload)) return;
    void (async () => {
      try {
        await startFromStoredSession();
        assertPageActive();
        const state = roomState();
        if (state.userId !== payload.userId) throw new Error("登录身份尚未同步，请重试");
        await window.goodPuppy.emitToWindow("lounge", ROOM_STATE_RESULT, { requestId: payload.requestId, ok: true, ...state });
      } catch (error) {
        if (page.signal.aborted) return;
        await window.goodPuppy.emitToWindow("lounge", ROOM_STATE_RESULT, { requestId: payload.requestId, ok: false,
          error: error instanceof Error ? error.message : "读取房间状态失败" });
      }
    })().catch(console.error);
  });

  let latestRequest: string | null = null;
  listenPage(ROOM_COMMAND, (payload) => {
    if (!isRoomCommand(payload)) return;
    latestRequest = payload.requestId;
    const diagnostic = { operation: payload.action === "enter" ? "room-enter" as const : "room-exit" as const,
      requestId: payload.requestId, roomId: payload.roomId };
    recordLifecycle({ ...diagnostic, phase: "start", sessionVersion: getRoomRevision() });
    void executeRoomCommand(payload, {
      enter: async (roomId) => { await startFromStoredSession(); assertPageActive(); await switchRoom(roomId); },
      exit: exitCurrentRoom,
      sync: () => visibility.sync(),
      getRoomId: getCurrentRoomId,
      getRevision: getRoomRevision,
    }).then(async (result) => {
      recordLifecycle({ ...diagnostic, phase: result.ok ? "ok" : "failed", sessionVersion: getRoomRevision() });
      if (latestRequest === payload.requestId) latestRequest = null;
      if (page.signal.aborted) return;
      await window.goodPuppy.emitToWindow(payload.replyTo, ROOM_RESULT, result);
    }).catch(console.error);
  });

  listenPage<{ requestId?: string }>(ROOM_CANCEL, (payload) => {
    if (payload?.requestId !== latestRequest) return;
    latestRequest = null;
    void exitCurrentRoom().finally(() => visibility.sync()).catch(console.error);
  });

  // 自己的右键菜单只有退出操作，不参与会客厅请求回执。
  listenPage("exit-room", () => {
    void exitCurrentRoom().finally(() => visibility.sync()).catch(console.error);
  });

  // 会客厅资料卡换肤面板「保存」后广播：应用到自己 pet（动画 + presence 通道 A）。
  listenPage("set-skin", (payload) => {
    if (isOwnSkinUpdate(payload, getSelfAuthId())) setSelfSkin(payload.skin);
  });

  // 退出前清理 presence，完成后通知 Rust 可以 exit（握手）。
  // 崩溃/强杀场景由 lounge 的 last_seen 时间阈值兜底。
  listenPage<{ requestId: string }>("app-before-quit", (payload) => {
    void (async () => {
      if (!payload?.requestId) return;
      await exitCurrentRoom({ rememberRoom: true }).catch(console.error);
      if (!page.signal.aborted) await emit("app-quit-ready", { requestId: payload.requestId });
    })().catch(console.error);
  });
}
