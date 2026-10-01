// 自己窗口（label "main"）的控制器：既是「自己 pet 的呈现者」，又是房间「协调者」宿主。
//
// 多窗口拆分后，远程成员各自是独立窗口（见 roomCoordinator.ts / petPresenter.ts）。
// 本文件只负责：渲染自己这一只 pet、自己的输入条/右键菜单/换肤/缩放/状态，
// 并把 roomManager 的订阅回调接到协调者上。
import { PetAnimator } from "./petState.js";
import * as presence from "./presence.js";
import { loadPetManifest, DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, getPetWindowSize, isWindowPositionVisible } from "./petLayout.js";
import { clearSelfPos } from "./petPositionStore.js";
import {
  readStoredSkin,
  writeStoredSkin,
  readStoredScale,
  writeStoredScale,
} from "./preferences.js";
import { createPetPresenter } from "./petPresenter.js";
import { createRoomCoordinator } from "./roomCoordinator.js";
import {
  BUBBLE_SELF_LABEL,
  SELF_OPEN_COMPOSE,
  SELF_COMPOSE_SUBMIT,
  SELF_COMPOSE_RESULT,
  PET_PREF_MODE,
  PET_PREF_SCALE,
  type SelfComposeSubmitPayload,
  type PetPrefModePayload,
  type PetPrefScalePayload,
} from "./petWindowEvents.js";
import { emit } from "@tauri-apps/api/event";
import { showSelfContextMenu } from "./contextMenu.js";
import {
  initRoomManager,
  getCurrentRoomId,
  getRoomRevision,
  getActiveSupabase,
  getSelfAuthId,
  startPetApp,
  stopPetApp,
  switchRoom,
  exitCurrentRoom,
} from "./roomManager.js";
import type { PetStatus, WindowPoint } from "../../types";

export { startPetApp, stopPetApp, switchRoom, getCurrentRoomId, getRoomRevision, exitCurrentRoom };

// 右键菜单「退出房间」：发 "exit-room" 给本窗口（selfMain 统一处理：退出 → 隐藏 →
// 通知会客厅刷新），与会客厅退出按钮走完全相同的链路，避免行为分叉。
function leaveCurrentRoomFromMenu() {
  return emit("exit-room");
}

let _onRoomReadyCb: (() => void) | null = null;
export function setOnRoomReadyCallback(fn: () => void) {
  _onRoomReadyCb = fn;
}

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const selfArea = document.querySelector<HTMLElement>('.dog-area[data-user="self"]');
const petImage = document.querySelector<HTMLImageElement>('.pet-image[data-user="self"]');

let selfPetId = "default";
let selfSkin = readStoredSkin();
let petScale = readStoredScale();

function applyPetScale() {
  document.documentElement.style.setProperty("--pet-scale", String(petScale));
}

const selfAnimator = new PetAnimator({ petId: selfPetId, skin: selfSkin });

if (!petStage || !selfArea || !petImage) {
  throw new Error("pet stage / self area missing in self window");
}

applyPetScale();
selfArea.style.setProperty("--pet-index", "0");

const presenter = createPetPresenter({
  stage: petStage,
  petImage,
  animator: selfAnimator,
  isDraggable: () => true,
  onShowContextMenu: (event) => showPetContextMenu(event),
  onDragEnded: (pos) => coordinator.handleSelfMoved(pos),
});

// pet.html 初始带 is-initializing（opacity:0）以避免首帧闪烁；远程窗口在
// remotePresenterMain 里摘掉，自己窗口必须在这里摘掉，否则自己的 pet 永远透明不可见。
petStage.classList.remove("is-initializing");

const coordinator = createRoomCoordinator({
  selfPresenter: presenter,
  getSelfAuthId: () => getSelfAuthId(),
  getCurrentRoomId: () => getCurrentRoomId(),
  getScale: () => petScale,
});

loadPetManifest(selfPetId).then((manifest) => {
  selfAnimator.setManifest(manifest);
  selfAnimator.playTransient("enter");
});

// ── Persistent status / skin / scale / mode ───────────────────────────────
function setSelfStatus(status: PetStatus) {
  selfAnimator.setStatus(status);
  presence.updateLocalPresence({ status }).catch(console.error);
}

// 由会客厅资料卡换肤面板「保存」后跨窗口调用（见 selfMain 的 "set-skin" 监听）：
// 更新本窗口动画 + 缓存 + presence 广播（通道 A，远程宠物窗口随之实时换肤）。
export function setSelfSkin(skin: string | null | undefined) {
  const next = skin || DEFAULT_SKIN;
  if (next === selfSkin) return;
  selfSkin = next;
  selfAnimator.setSkin(next);
  writeStoredSkin(next);
  presence.updateLocalPresence({ skin: next }).catch(console.error);
}

function setPetScale(next: number | string | null | undefined) {
  const clamped = clampPetScale(next);
  if (clamped === petScale) return;
  petScale = clamped;
  applyPetScale();
  writeStoredScale(petScale);
  void resizeSelfWindow();
  coordinator.refreshArrangement();
}

/** pet 窗口固定 pet 尺寸（气泡在 bubble-self）。缩放时按新尺寸重设窗口，并保持视觉
 * 底边不变（宠物锚定窗口底部），避免宠物随缩放上下跳。气泡窗口由 OS 跟随。 */
async function resizeSelfWindow() {
  const [cur, pos] = await Promise.all([
    window.goodPuppy.getWindowSize(),
    window.goodPuppy.getWindowPosition(),
  ]);
  const size = getPetWindowSize(petScale);
  const top = pos.y + cur.height - size.height;
  window.goodPuppy.setWindowBounds({ x: pos.x, y: top, width: size.width, height: size.height });
  // 自己窗口尺寸变了，气泡窗口随之重排（上/下避让 + 居中）。
  void coordinator.refreshSelfBubble();
}

// ── 写消息链路（记号棒在 bubble-self，跨窗口回环）─────────────────────────
// 自己的气泡窗口提交文本 → 这里走 Supabase 插入 → 回报结果给气泡窗口收尾。
window.goodPuppy.onAppEvent<SelfComposeSubmitPayload>(SELF_COMPOSE_SUBMIT, async ({ text, requestId, roomId: requestedRoomId }) => {
  if (!requestId || typeof text !== "string") return;
  const version = getRoomRevision();
  try {
    const supabase = getActiveSupabase();
    const authId = getSelfAuthId();
    const roomId = getCurrentRoomId();
    if (!supabase || !authId || !roomId) throw new Error("请先登录并进入房间");
    if (roomId !== requestedRoomId) throw new Error("房间已改变，请重新发送");
    const { data, error } = await supabase
      .from("messages")
      .insert({ room_id: roomId, sender_id: authId, kind: "text", content: text })
      .select("id, created_at")
      .single();
    if (error) throw error;
    if (version !== getRoomRevision()) throw new Error("消息已发送到原房间，当前房间已改变");
    selfAnimator.playTransient("message");
    // 用数据库返回的真实 ID 立即路由（投到 bubble-self），realtime 抵达时按 ID 去重。
    coordinator.onNewMessage({ id: data.id, info: text, from: authId, created_at: data.created_at });
    void window.goodPuppy.emitToWindow(BUBBLE_SELF_LABEL, SELF_COMPOSE_RESULT, { requestId, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void window.goodPuppy.emitToWindow(BUBBLE_SELF_LABEL, SELF_COMPOSE_RESULT, { requestId, ok: false, error: message });
  }
});

// ── 会客厅设置页遥控 ─────────────────────────────────────────────────────
// 偏好的唯一执行 + 落盘点在 main：会客厅只发事件，这里应用并持久化。
window.goodPuppy.onAppEvent<PetPrefModePayload>(PET_PREF_MODE, ({ mode }) => {
  coordinator.setMode(mode);
});
window.goodPuppy.onAppEvent<PetPrefScalePayload>(PET_PREF_SCALE, ({ scale }) => {
  setPetScale(scale);
});

// ── Context menu (self) ────────────────────────────────────────────────────
async function showPetContextMenu(event: MouseEvent) {
  void event;
  await showSelfContextMenu({
    inRoom: Boolean(getCurrentRoomId()),
    // 「写消息」通知自己的气泡窗口展开记号棒（聚焦逻辑亦在那边处理）。
    onWriteMessage: () => void window.goodPuppy.emitToWindow(BUBBLE_SELF_LABEL, SELF_OPEN_COMPOSE),
    onSetStatus: setSelfStatus,
    onLeaveRoom: () => void leaveCurrentRoomFromMenu(),
  });
}

// ── Room manager wiring ────────────────────────────────────────────────────
initRoomManager({
  onPresenceChange: coordinator.onPresenceChange,
  onInteraction: coordinator.onInteraction,
  onMessagesLoaded: coordinator.onMessagesLoaded,
  onNewMessage: coordinator.onNewMessage,
  onRoomReady: () => _onRoomReadyCb?.(),
  onEnterRoom: () => selfAnimator.playTransient("enter"),
  onClearRemotePets: coordinator.onClearRemotePets,
  onPetIdResolved: (petId) => {
    selfPetId = petId;
    selfAnimator.setPetId(petId);
    loadPetManifest(petId).then((manifest) => selfAnimator.setManifest(manifest));
  },
  getSelfAnimator: () => selfAnimator,
  getSelfPetId: () => selfPetId,
  getSelfSkin: () => selfSkin,
  getSelfStatus: () => selfAnimator.status,
});

let selfPositionRestored = false;
async function restoreSelfPosition() {
  if (selfPositionRestored) return;
  selfPositionRestored = true;
  // pet 窗口固定 pet 尺寸：进房间时按当前缩放对齐窗口尺寸（不再靠 applyWindowLayout）。
  const size = getPetWindowSize(petScale);
  const stored: WindowPoint | null = coordinator.storedSelfPos;
  // 存档位置必须落在当前某块屏幕的可见区内才采用：外接显示器断开后，旧坐标
  // （如 x=1588）会整窗落在屏外，pet 看不见也抓不回。此时清掉坏存档、回退默认摆位。
  if (stored) {
    const monitors = await window.goodPuppy.getMonitors();
    if (isWindowPositionVisible(stored, size, monitors)) {
      window.goodPuppy.setWindowBounds({ x: stored.x, y: stored.y, width: size.width, height: size.height });
      return;
    }
    clearSelfPos();
  }
  window.goodPuppy.setWindowSize(size);
}

/** 显隐控制器在显示宠物之前调用，窗口准备也属于同一串行流程。 */
export async function prepareSelfForRoom() {
  if (!getCurrentRoomId()) return;
  await restoreSelfPosition();
  if (!getCurrentRoomId()) return;
  await coordinator.ensureSelfBubble();
  presenter.refreshPassthrough();
}
