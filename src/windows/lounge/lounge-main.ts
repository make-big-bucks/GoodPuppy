import { createRoomCommandClient } from "./roomCommandClient.js";
import { createResourceLifetime } from "../../shared/resourceLifetime.js";
import { createRoomStateSync } from "./roomStateSync.js";
import { requestRoomState, type RoomState } from "../../shared/roomState.js";
import { showToast } from "./views/toast.js";
import "../../shared/bridge.js";
import "../../shared/styles.css";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLoungeChrome } from "./loungeChrome.js";
import { initLoungePanel, openActiveRoomHistory, openLoungePanel, refreshLoungePanelActiveRoom, updateLoungePanelAuth } from "./lounge.js";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";
import appConfig from "../../shared/appConfig.js";
import { getSupabaseStorageKey } from "../../shared/backendConfig.js";
import { showPanelSkeleton, hidePanelState } from "./views/panelState.js";

// 是否存在已持久化的登录态。Supabase 把 session 存在 localStorage 的
// `sb-<ref>-auth-token` 键里，这里同步探测，用于在 await getSession() 之前就决定
// 要不要先铺骨架屏（已登录用户冷启动几乎必然有这个键）。
function hasPersistedSession(): boolean {
  try {
    return Boolean(localStorage.getItem(getSupabaseStorageKey(appConfig.supabase)));
  } catch {
    /* localStorage 不可用时按未登录处理 */
  }
  return false;
}

import { ROOM_COMMAND, ROOM_CANCEL, ROOM_RESULT, type RoomResult } from "../../shared/roomProtocol.js";
import { requestWindow } from "../../shared/windowRequest.js";

const supabase = createAppSupabaseClient();
let authenticatedUserId: string | null = null;

function sessionIsAnonymous(session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]) {
  return Boolean(session?.user?.is_anonymous);
}

let requests = new AbortController();
const page = createResourceLifetime();
function listenPage<T = unknown>(event: string, handler: (payload: T) => void) {
  page.own(window.goodPuppy.onAppEvent<T>(event, (payload) => { if (!page.signal.aborted) handler(payload); }));
}
window.addEventListener("beforeunload", () => { page.dispose(); requests.abort(); roomStateSync.reset(); }, { once: true });
const roomStateSync = createRoomStateSync({
  context: () => ({ userId: authenticatedUserId, signal: requests.signal }),
  read: (userId, signal) => requestRoomState({
    listen: (event, handler) => window.goodPuppy.onAppEvent(event, handler),
    send: (target, event, payload) => window.goodPuppy.emitToWindow(target, event, payload),
  }, userId, signal),
  changed: refreshLoungePanelActiveRoom,
  failed: reportStateError,
});
const synchronizeActiveRoom = () => roomStateSync.sync();

function reportStateError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  showToast(error instanceof Error ? error.message : "读取房间状态失败", "error");
}

const roomCommands = createRoomCommandClient({
  context: () => ({ userId: authenticatedUserId, signal: requests.signal }),
  request: (action, roomId, signal) => requestWindow<RoomResult>({
    listen: (event, handler) => window.goodPuppy.onAppEvent(event, handler),
    send: (target, event, payload) => window.goodPuppy.emitToWindow(target, event, payload),
  }, { target: "main", requestEvent: ROOM_COMMAND, responseEvent: ROOM_RESULT,
    payload: { action, roomId, replyTo: "lounge" }, signal, cancelEvent: ROOM_CANCEL }),
  synchronize: synchronizeActiveRoom,
  currentRoom: () => roomStateSync.roomId,
  entered: async () => { await getCurrentWindow().hide(); await emit("lounge-hidden"); },
});

async function init() {
  // 冷启动先铺骨架屏，避免在 await getSession()（多窗口共享 auth 锁时可能较慢）期间
  // 露出尚未加载数据的静态页面。若实际未登录，下面 openLoungePanel 的非登录分支会撤掉。
  if (hasPersistedSession()) showPanelSkeleton();

  const { data } = await supabase.auth.getSession();
  if (page.signal.aborted) return;
  const selfAuthId = data.session?.user?.id || null;

  initLoungePanel({
    supabase,
    selfAuthId,
    isAnonymous: sessionIsAnonymous(data.session),
    email: data.session?.user?.email ?? null,
    getActiveRoomId: () => roomStateSync.roomId,
    onEnterRoom: (roomId: string) => roomCommands.change("enter", roomId),
    onExitRoom: () => roomCommands.change("exit"),
    onLoginSuccess: () => {
      void emit("auth-ready");
    },
    onLogout: () => {
      requests.abort();
      requests = new AbortController();
      void emit("auth-cleared");
      roomStateSync.reset();
    },
    onSkinSaved: (skin: string, userId: string) => {
      void window.goodPuppy.emitToWindow("main", "set-skin", { skin, userId }).catch(console.error);
    },
  });

  authenticatedUserId = selfAuthId;
  // INITIAL_SESSION 也参与身份同步，重复会话由上下文比较消除。
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    if (page.signal.aborted) return;
    const nextUserId = session?.user.id ?? null;
    if (nextUserId !== authenticatedUserId) {
      requests.abort();
      requests = new AbortController();
      roomStateSync.reset();
      authenticatedUserId = nextUserId;
      void synchronizeActiveRoom().catch(reportStateError);
    }
    updateLoungePanelAuth({
      supabase,
      selfAuthId: session?.user?.id || null,
      isAnonymous: sessionIsAnonymous(session),
      email: session?.user?.email ?? null,
    });
  });

  page.own(() => subscription.unsubscribe());

  listenPage("lounge-refresh", () => {
    openLoungePanel();
    void synchronizeActiveRoom().catch(reportStateError);
  });

  listenPage("open-room-history", () => {
    openLoungePanel();
    const signal = requests.signal; const userId = authenticatedUserId;
    void synchronizeActiveRoom().then(() => {
      if (signal.aborted || userId !== authenticatedUserId) throw new DOMException("账号已改变", "AbortError");
      return openActiveRoomHistory();
    }).catch(reportStateError);
  });

  listenPage<RoomState>("active-room-changed", (state) => {
    roomStateSync.receive(state);
  });

  openLoungePanel();

  if (selfAuthId) {
    void synchronizeActiveRoom().catch(reportStateError);
  }

  await initLoungeChrome(page);
}

init().catch(console.error);
