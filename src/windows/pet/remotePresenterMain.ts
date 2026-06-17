// 远程 pet 窗口（label "pet-<userId>"）的入口：纯「哑呈现者」。
//
// 不碰 Supabase。只渲染一只远程成员的 pet，听协调者（"main" 窗口）的定向事件播动画/气泡，
// 拖动结束把新位置上报回协调者。见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import "../../shared/bridge.js";
import "../../shared/styles.css";
import { PetAnimator } from "./petState.js";
import { loadPetManifest } from "./animationCatalog.js";
import { getPetWindowSize } from "./petLayout.js";
import { createPetPresenter } from "./petPresenter.js";
import { showRemoteContextMenu } from "./contextMenu.js";
import {
  userIdFromLabel,
  COORDINATOR_LABEL,
  PET_STATE,
  PET_HISTORY,
  PET_MESSAGE,
  PET_INTERACTION,
  PET_LEAVE,
  PET_MODE,
  PET_ARRANGE,
  PET_MOVED,
  PET_INTERACT_REQUEST,
  type PetStatePayload,
  type PetHistoryPayload,
  type PetMessagePayload,
  type PetInteractionPayload,
  type PetModePayload,
  type PetArrangePayload,
} from "./petWindowEvents.js";

const bridge = window.goodPuppy;
const userId = userIdFromLabel(bridge.getWindowLabel()) ?? "";

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const area = document.querySelector<HTMLElement>(".dog-area");
const petImage = area?.querySelector<HTMLImageElement>(".pet-image") ?? null;
const composeStick = document.querySelector<HTMLElement>(".compose-stick");
// 远程窗口没有输入条：移除它，避免命中/布局误判。
composeStick?.remove();

if (petStage && area && petImage) {
  area.dataset.user = "remote";
  area.dataset.userId = userId;
  area.style.setProperty("--pet-index", "0");

  let draggable = false;
  let currentPetId = "default";

  const animator = new PetAnimator({ petId: currentPetId, skin: "default" });

  const presenter = createPetPresenter({
    stage: petStage,
    area,
    petImage,
    animator,
    getScale: () => 1,
    isDraggable: () => draggable,
    onShowContextMenu: () =>
      showRemoteContextMenu({
        targetId: userId,
        onShowRemoteStatus: () => presenter.showBubble(),
        onInteract: (action, targetId) =>
          void bridge.emitToWindow(COORDINATOR_LABEL, PET_INTERACT_REQUEST, { action, targetId }),
      }),
    onDragEnded: (pos) => void bridge.emitToWindow(COORDINATOR_LABEL, PET_MOVED, { userId, ...pos }),
  });

  petStage.classList.remove("is-initializing");

  bridge.onAppEvent<PetStatePayload>(PET_STATE, (payload) => {
    if (payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      animator.setPetId(payload.petId);
      loadPetManifest(payload.petId).then((manifest) => {
        animator.setManifest(manifest);
        animator.playTransient("enter");
      });
    }
    animator.setSkin(payload.skin);
    animator.setStatus(payload.status);
  });

  bridge.onAppEvent<PetHistoryPayload>(PET_HISTORY, (payload) => presenter.setMessages(payload.messages));
  bridge.onAppEvent<PetMessagePayload>(PET_MESSAGE, (payload) => {
    presenter.addMessage(payload.message);
    animator.playTransient("message");
  });
  bridge.onAppEvent<PetInteractionPayload>(PET_INTERACTION, (payload) =>
    animator.playTransient(payload.state, { durationMs: payload.durationMs, mirrored: payload.mirrored }),
  );
  bridge.onAppEvent<void>(PET_LEAVE, () => animator.playTransient("leave"));
  bridge.onAppEvent<PetModePayload>(PET_MODE, (payload) => {
    draggable = payload.draggable;
  });
  bridge.onAppEvent<PetArrangePayload>(PET_ARRANGE, (pos) => {
    const size = getPetWindowSize(1);
    bridge.setWindowBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    void presenter.applyWindowLayout("arrange");
  });
}
