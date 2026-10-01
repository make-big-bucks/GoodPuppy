import { createPresenterEndpoint } from "./windowReadiness.js";
// 远程 pet 窗口（label "pet-<userId>"）的入口：纯「哑呈现者」。
//
// 不碰 Supabase。只渲染一只远程成员的 pet，听协调者（"main" 窗口）的定向事件播动画/气泡，
// 拖动结束把新位置上报回协调者。见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import "../../shared/bridge.js";
import "../../shared/styles.css";
import { PetAnimator } from "./petState.js";
import { loadPetManifest } from "../../shared/pet/animationCatalog.js";
import { getPetWindowSize } from "../../shared/pet/petLayout.js";
import { createPetPresenter } from "./petPresenter.js";
import { showRemoteContextMenu } from "./contextMenu.js";
import {
  userIdFromLabel,
  bubbleWindowLabel,
  COORDINATOR_LABEL,
  PET_STATE,
  PET_INTERACTION,
  PET_LEAVE,
  PET_MODE,
  PET_ARRANGE,
  PET_MOVED,
  PET_INTERACT_REQUEST,
  PET_BUBBLE_SHOW_REQUEST,
  type PetStatePayload,
  type PetInteractionPayload,
  type PetModePayload,
  type PetArrangePayload,
} from "../../shared/pet/petWindowEvents.js";

const bridge = window.goodPuppy;
const instanceId = bridge.getWindowInstance();
const endpoint = createPresenterEndpoint({ label: bridge.getWindowLabel(), instanceId,
  listen: (event, handler) => bridge.onAppEvent(event, handler),
  send: (label, event, payload) => bridge.emitToWindow(label, event, payload),
});
const userId = userIdFromLabel(bridge.getWindowLabel()) ?? "";

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const area = document.querySelector<HTMLElement>(".dog-area");
const petImage = area?.querySelector<HTMLImageElement>(".pet-image") ?? null;
const composeStick = document.querySelector<HTMLElement>(".compose-stick");
// 远程 pet 窗口没有输入条；气泡也搬进独立气泡窗口（bubble-<userId>，多窗口 Phase A）。
// 移除窗口内的记号棒与气泡堆叠，pet 窗口只剩单 pet 动画 + 拖动 + 像素命中。
composeStick?.remove();
area?.querySelector(".bubble-stack")?.remove();

if (petStage && area && petImage) {
  area.dataset.user = "remote";
  area.dataset.userId = userId;
  area.style.setProperty("--pet-index", "0");

  let draggable = false;
  let currentPetId: string | null = null;

  const animator = new PetAnimator({ petId: currentPetId ?? "default", skin: "default" });

  const presenter = createPetPresenter({
    stage: petStage,
    petImage,
    animator,
    isDraggable: () => draggable,
    onShowContextMenu: () =>
      showRemoteContextMenu({
        targetId: userId,
        // 气泡在独立气泡窗口里：「查看状态」改为通知该气泡窗口重新展开堆叠。
        onShowRemoteStatus: () => void bridge.emitToWindow(COORDINATOR_LABEL, PET_BUBBLE_SHOW_REQUEST, { userId, instanceId }),
        onInteract: (action, targetId) =>
          void bridge.emitToWindow(COORDINATOR_LABEL, PET_INTERACT_REQUEST, { action, targetId, instanceId }),
      }),
    onDragEnded: (pos) => void bridge.emitToWindow(COORDINATOR_LABEL, PET_MOVED, { userId, instanceId, ...pos }),
  });

  endpoint.listen<PetStatePayload>(PET_STATE, (payload) => {
    petStage.classList.remove("is-initializing");
    presenter.refreshPassthrough();
    if (payload.petId && payload.petId !== currentPetId) {
      currentPetId = payload.petId;
      animator.setPetId(payload.petId);
      loadPetManifest(payload.petId).then((manifest) => {
        if (payload.petId !== currentPetId) return;
        animator.setManifest(manifest);
        animator.playTransient("enter");
      });
    }
    animator.setSkin(payload.skin);
    animator.setStatus(payload.status);
  });

  // 消息渲染搬到气泡窗口（bubble-<userId>）。pet 窗口只在新消息时弹跳一下：
  // 协调者用 PET_INTERACTION{state:"message"} 通知，复用下方互动动画通道。
  endpoint.listen<PetInteractionPayload>(PET_INTERACTION, (payload) =>
    animator.playTransient(payload.state, { durationMs: payload.durationMs, mirrored: payload.mirrored }),
  );
  endpoint.listen<void>(PET_LEAVE, () => animator.playTransient("leave"));
  endpoint.listen<PetModePayload>(PET_MODE, (payload) => {
    draggable = payload.draggable;
  });
  endpoint.listen<PetArrangePayload>(PET_ARRANGE, (pos) => {
    const size = getPetWindowSize(1);
    // 只重设 pet 窗口位置/尺寸；气泡子窗口由 OS 跟随（macOS）/Moved 重定位（Windows）。
    void bridge.setWindowBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
  });
  void endpoint.ready().catch(console.error);
  window.addEventListener("beforeunload", () => { endpoint.dispose(); presenter.dispose(); });

}
