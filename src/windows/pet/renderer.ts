// 自己窗口（label "main"）的控制器：既是「自己 pet 的呈现者」，又是房间「协调者」宿主。
//
// 多窗口拆分后，远程成员各自是独立窗口（见 roomCoordinator.ts / petPresenter.ts）。
// 本文件只负责：渲染自己这一只 pet、自己的输入条/右键菜单/换肤/缩放/状态，
// 并把 roomManager 的订阅回调接到协调者上。
import { PetAnimator } from "./petState.js";
import * as presence from "./presence.js";
import { loadPetManifest, DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, getPetWindowSize } from "./petLayout.js";
import {
  readStoredSkin,
  writeStoredSkin,
  readStoredScale,
  writeStoredScale,
} from "./preferences.js";
import { createPetPresenter } from "./petPresenter.js";
import { createRoomCoordinator } from "./roomCoordinator.js";
import {
  initComposeStick,
  openComposeStick,
  isComposeOpen,
  getComposeStickElement,
} from "./composeStick.js";
import { showSelfContextMenu } from "./contextMenu.js";
import {
  initRoomManager,
  getCurrentRoomId,
  getActiveSupabase,
  getSelfAuthId,
  startPetApp,
  switchRoom,
  exitCurrentRoom,
} from "./roomManager.js";
import type { PetStatus, WindowPoint } from "../../types";

export { startPetApp, switchRoom, getCurrentRoomId, exitCurrentRoom };

let _onRoomReadyCb: (() => void) | null = null;
export function setOnRoomReadyCallback(fn: () => void) {
  _onRoomReadyCb = fn;
}

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const selfArea = document.querySelector<HTMLElement>('.dog-area[data-user="self"]');
const petImage = document.querySelector<HTMLImageElement>('.pet-image[data-user="self"]');
const selfComposeStick = document.querySelector<HTMLElement>('.compose-stick[data-user="self"]');

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
  area: selfArea,
  petImage,
  animator: selfAnimator,
  getScale: () => petScale,
  isDraggable: () => true,
  hasComposeOpen: () => isComposeOpen(),
  onShowContextMenu: (event) => showPetContextMenu(event),
  onDragEnded: (pos) => coordinator.handleSelfMoved(pos),
});

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

function setSelfSkin(skin: string | null | undefined) {
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
  void presenter.applyWindowLayout("scale");
  coordinator.refreshArrangement();
}

// ── Compose stick (self only) ─────────────────────────────────────────────
if (selfComposeStick) {
  initComposeStick(selfComposeStick, {
    onRefreshPassthrough: () => presenter.refreshPassthrough(),
    onVisibilityChange: () => void presenter.applyWindowLayout("compose-visibility"),
    onSubmitMessage: async (info) => {
      const supabase = getActiveSupabase();
      const authId = getSelfAuthId();
      const roomId = getCurrentRoomId();
      if (!supabase || !authId || !roomId) throw new Error("请先登录");
      const { data, error } = await supabase
        .from("messages")
        .insert({ room_id: roomId, sender_id: authId, kind: "text", content: info })
        .select("id, created_at")
        .single();
      if (error) throw error;
      selfAnimator.playTransient("message");
      // 用数据库返回的真实 ID 立即路由，realtime 抵达时按 ID 去重。
      coordinator.onNewMessage({ id: data.id, info, from: authId, created_at: data.created_at });
    },
  });
}

// ── Context menu (self) ────────────────────────────────────────────────────
async function showPetContextMenu(event: MouseEvent) {
  void event;
  await showSelfContextMenu({
    selfSkin,
    petScale,
    manifest: selfAnimator.manifest,
    hasMessages: presenter.hasMessages(),
    petMode: coordinator.getMode(),
    onShowMessage: () => presenter.showBubble(),
    onWriteMessage: openComposeStick,
    onSetStatus: setSelfStatus,
    onSetSkin: setSelfSkin,
    onSetScale: setPetScale,
    onSetMode: (mode) => coordinator.setMode(mode),
  });

  // 「写消息」在原生菜单的嵌套事件循环里触发；菜单收起会让面板失去 key 状态。
  // 等菜单完全消失后于下一帧重新取 key + 聚焦，输入框才能收键。
  if (isComposeOpen()) {
    requestAnimationFrame(() => {
      void window.goodPuppy.setFocus("post-menu-raf");
      getComposeStickElement()?.querySelector<HTMLTextAreaElement>(".compose-input")?.focus();
    });
  }
}

// ── Room manager wiring ────────────────────────────────────────────────────
initRoomManager({
  onPresenceChange: coordinator.onPresenceChange,
  onInteraction: coordinator.onInteraction,
  onMessagesLoaded: coordinator.onMessagesLoaded,
  onNewMessage: coordinator.onNewMessage,
  onRoomReady: () => {
    restoreSelfPosition();
    presenter.refreshPassthrough();
    _onRoomReadyCb?.();
  },
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
function restoreSelfPosition() {
  if (selfPositionRestored) return;
  const stored: WindowPoint | null = coordinator.storedSelfPos;
  if (!stored) return;
  selfPositionRestored = true;
  const size = getPetWindowSize(petScale);
  window.goodPuppy.setWindowBounds({ x: stored.x, y: stored.y, width: size.width, height: size.height });
}
