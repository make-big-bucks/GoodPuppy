import { PetAnimator } from "./petState.js";
import { loadPetManifest, DEFAULT_SKIN } from "./animationCatalog.js";
import { isPointOpaqueInImage } from "./hitTesting.js";
import * as presence from "./presence.js";
import { clampPetScale, stepPetScale, DEFAULT_PET_SCALE, MIN_PET_SCALE, MAX_PET_SCALE } from "./petLayout.js";
import { readStoredSkin, writeStoredSkin, readStoredScale, writeStoredScale } from "./preferences.js";
import {
  initMessageBubble,
  setLocalMessages,
  addLocalMessage,
  showMessageBubble,
  closeMessageBubble,
  openComposer,
  closeComposer,
  isComposerOpen,
  getBubbleElement,
  hasMessages,
} from "./messageBubble.js";
import {
  initRemotePets,
  applyPresence,
  clearRemotePets,
  relayoutRemotePets,
  getPetIdentityForEvent,
  showRemoteBubble,
} from "./remotePets.js";
import { initPetInteractions, applyInteraction, triggerInteraction } from "./petInteractions.js";
import { showSelfContextMenu, showRemoteContextMenu } from "./contextMenu.js";
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

type PointerPoint = { x: number; y: number };
type HoverEventLike = { clientX: number; clientY: number; target: EventTarget | null };
type StateMeta = { mirrored?: boolean };

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const cloudHitImage = new Image();
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const alphaHitThreshold = 16;
const alphaHitSlop = 3;
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

const petImage = document.querySelector<HTMLImageElement>('.pet-image[data-user="self"]');
const selfArea = document.querySelector<HTMLElement>('.dog-area[data-user="self"]');
const selfBubble = document.querySelector<HTMLElement>('.message-bubble[data-user="self"]');

selfBubble?.classList.add("is-owned");

let selfPetId = "default";
let selfSkin = readStoredSkin();
let petScale = readStoredScale();

let pointerStart: PointerPoint | null = null;
let windowStart: WindowPoint | null = null;
let isDragging = false;
let bubblePointerStart = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent: HoverEventLike | null = null;
let dragLiftTimer: ReturnType<typeof setTimeout> | null = null;
let isNativeDragging = false;

function applyStateToImage(img: HTMLImageElement | null, path: string, meta: StateMeta) {
  if (!img) return;
  img.src = path;
  img.classList.toggle("is-mirrored", Boolean(meta?.mirrored));
}

// ── Self pet animator ─────────────────────────────────────────

function applyPetScale() {
  document.documentElement.style.setProperty("--pet-scale", String(petScale));
}

function setPetScale(next: number | string | null | undefined) {
  const clamped = clampPetScale(next);
  if (clamped === petScale) return;
  petScale = clamped;
  applyPetScale();
  writeStoredScale(petScale);
  relayoutRemotePets();
}

const selfAnimator = new PetAnimator({
  petId: selfPetId,
  skin: selfSkin,
  onState: (_state, path, meta) => applyStateToImage(petImage, path, meta),
});

loadPetManifest(selfPetId).then((manifest) => {
  selfAnimator.setManifest(manifest);
  selfAnimator.playTransient("enter");
});

cloudHitImage.src = "/img/cloud_transparent.png";
applyPetScale();
selfArea?.style.setProperty("--pet-index", "0");
petStage?.classList.remove("is-initializing");

// ── Persistent status & skin ──────────────────────────────────

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

// ── Module initialization ─────────────────────────────────────

if (petStage && selfArea) {
  initRemotePets({
    stage: petStage,
    selfArea,
    getPetScale: () => petScale,
    onRefreshPassthrough: refreshMousePassthrough,
    onSelfGreet: () => selfAnimator.playTransient("greet"),
  });
}

initPetInteractions({
  getSelfAuthId: () => getSelfAuthId(),
  getSelfAnimator: () => selfAnimator,
});

if (selfBubble) {
  initMessageBubble(selfBubble, {
    onRefreshPassthrough: refreshMousePassthrough,
    onSubmitMessage: async (info) => {
      const supabase = getActiveSupabase();
      const authId = getSelfAuthId();
      const roomId = getCurrentRoomId();
      if (!supabase || !authId || !roomId) throw new Error("请先登录");
      const { error } = await supabase.from("messages").insert({
        room_id: roomId,
        sender_id: authId,
        kind: "text",
        content: info,
      });
      if (error) throw error;
      selfAnimator.playTransient("message");
      addLocalMessage(
        { id: `local-${Date.now()}`, info, from: authId, created_at: new Date().toISOString() },
        { markUnread: false },
      );
    },
  });
}

initRoomManager({
  onPresenceChange: applyPresence,
  onInteraction: applyInteraction,
  onMessagesLoaded: (messages) => setLocalMessages(messages),
  onNewMessage: (msg) => addLocalMessage(msg, { markUnread: false }),
  onRoomReady: () => {
    petStage?.classList.remove("is-initializing");
    refreshMousePassthrough();
    _onRoomReadyCb?.();
  },
  onEnterRoom: () => selfAnimator.playTransient("enter"),
  onClearRemotePets: clearRemotePets,
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

// ── Hit testing & mouse passthrough ──────────────────────────

function closestFromEvent<T extends Element>(
  event: { target: EventTarget | null },
  selector: string,
) {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest(selector) as T | null;
}

function isPetOpaqueAt(event: HoverEventLike) {
  const image = closestFromEvent<HTMLImageElement>(event, ".pet-image");
  if (!image) return false;
  return isPointOpaqueInImage(event, image, image, hitContext, hitCanvas, {
    respectObjectFit: true,
    alphaThreshold: alphaHitThreshold,
    hitSlop: alphaHitSlop,
  });
}

function isBubbleOpaqueAt(event: HoverEventLike) {
  const bubble = getBubbleForPoint(event);
  if (!bubble || bubble.hidden) return false;
  return isPointOpaqueInImage(event, bubble, cloudHitImage, hitContext, hitCanvas, {
    alphaThreshold: alphaHitThreshold,
    hitSlop: alphaHitSlop,
  });
}

function isPointInsideElement(event: HoverEventLike, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function getBubbleForPoint(event: HoverEventLike) {
  const targetBubble = closestFromEvent<HTMLElement>(event, ".message-bubble");
  if (targetBubble && !targetBubble.hidden && isPointInsideElement(event, targetBubble)) {
    return targetBubble;
  }
  return (
    [...document.querySelectorAll<HTMLElement>(".message-bubble:not([hidden])")].find((bubble) =>
      isPointInsideElement(event, bubble),
    ) || null
  );
}

function isBubbleControlAt(event: HoverEventLike) {
  const bubble = getBubbleForPoint(event);
  if (!bubble) return false;
  return [...bubble.querySelectorAll<HTMLElement>("button, textarea, input")].some((control) =>
    isPointInsideElement(event, control),
  );
}

function isInteractiveAt(event: HoverEventLike) {
  const bubble = getBubbleForPoint(event);
  if (isBubbleControlAt(event)) return true;
  if (isComposerOpen() && bubble) return true;
  if (bubble) return true;
  if (document.querySelector(".message-bubble:not([hidden])") && isBubbleOpaqueAt(event))
    return true;
  return isPetOpaqueAt(event);
}

function setMousePassthrough(shouldPassThrough: boolean) {
  if (isIgnoringMouseEvents === shouldPassThrough) return;
  isIgnoringMouseEvents = shouldPassThrough;
  window.goodPuppy.setIgnoreMouseEvents(shouldPassThrough);
}

function updateMousePassthrough(event: HoverEventLike) {
  lastPointerEvent = event;
  if (pointerStart || bubblePointerStart) {
    setMousePassthrough(false);
    return;
  }
  setMousePassthrough(!isInteractiveAt(event));
}

function refreshMousePassthrough() {
  if (lastPointerEvent) {
    const event = lastPointerEvent;
    window.requestAnimationFrame(() => updateMousePassthrough(event));
  }
}

document.addEventListener("mousemove", updateMousePassthrough);
document.addEventListener("mouseleave", () => {
  if (!pointerStart && !bubblePointerStart) setMousePassthrough(true);
});

window.goodPuppy.onCursorMoved((point) => {
  if (!point) return;
  const target = document.elementFromPoint(point.x, point.y) || document.body;
  updateMousePassthrough({ clientX: point.x, clientY: point.y, target });
});

// ── Drag-lift ─────────────────────────────────────────────────

function startDragLift() {
  selfAnimator.setHeld("drag-lift");
  if (dragLiftTimer != null) clearTimeout(dragLiftTimer);
  dragLiftTimer = setTimeout(stopDragLift, 4000);
}

function stopDragLift() {
  if (dragLiftTimer != null) {
    clearTimeout(dragLiftTimer);
    dragLiftTimer = null;
  }
  selfAnimator.setHeld(null);
}

// ── Pointer events ────────────────────────────────────────────

function targetElement(target: EventTarget | null) {
  return target instanceof Element ? target : null;
}

async function showPetContextMenu(event: MouseEvent) {
  const identity = getPetIdentityForEvent(event);

  if (identity.kind === "remote") {
    await showRemoteContextMenu({
      targetId: identity.id,
      onShowRemoteStatus: showRemoteBubble,
      onInteract: triggerInteraction,
    });
    return;
  }

  await showSelfContextMenu({
    selfSkin,
    petScale,
    manifest: selfAnimator.manifest,
    hasMessages: hasMessages(),
    onShowMessage: showMessageBubble,
    onWriteMessage: openComposer,
    onSetStatus: setSelfStatus,
    onSetSkin: setSelfSkin,
    onSetScale: setPetScale,
  });
}

petStage?.addEventListener("pointerdown", async (event: PointerEvent) => {
  setMousePassthrough(false);
  if (event.button !== 0) return;
  if (targetElement(event.target)?.closest(".bubble-composer")) return;
  if (targetElement(event.target)?.closest(".bubble-nav")) return;
  if (targetElement(event.target)?.closest(".bubble-text")) return;

  if (isBubbleOpaqueAt(event)) {
    bubblePointerStart = true;
    pointerStart = null;
    windowStart = null;
    isDragging = false;
    return;
  }

  if (!isPetOpaqueAt(event)) return;

  if (getPetIdentityForEvent(event).kind === "self") startDragLift();

  if (supportsNativeWindowDrag) {
    isNativeDragging = true;
    window.goodPuppy.startWindowDrag();
    return;
  }

  pointerStart = { x: event.screenX, y: event.screenY };
  isDragging = false;
  petStage?.setPointerCapture(event.pointerId);
  windowStart = await window.goodPuppy.getWindowPosition();
});

petStage?.addEventListener("contextmenu", (event: MouseEvent) => {
  if (
    targetElement(event.target)?.closest(".bubble-composer") ||
    targetElement(event.target)?.closest(".bubble-nav") ||
    targetElement(event.target)?.closest(".bubble-text")
  )
    return;
  event.preventDefault();
  if (isBubbleOpaqueAt(event)) return;
  if (!isPetOpaqueAt(event)) return;
  showPetContextMenu(event).catch(console.error);
});

petStage?.addEventListener("pointermove", (event: PointerEvent) => {
  updateMousePassthrough(event);
  if (!pointerStart) return;
  const deltaX = event.screenX - pointerStart.x;
  const deltaY = event.screenY - pointerStart.y;
  isDragging = true;
  if (windowStart) {
    window.goodPuppy.setWindowPosition({
      x: windowStart.x + deltaX,
      y: windowStart.y + deltaY,
    });
  }
});

petStage?.addEventListener("pointerup", (event: PointerEvent) => {
  if (targetElement(event.target)?.closest(".bubble-nav")) return;
  if (targetElement(event.target)?.closest(".bubble-composer")) return;

  if (bubblePointerStart) {
    if (event.button === 0 && isBubbleOpaqueAt(event)) {
      if (!isComposerOpen()) closeMessageBubble();
    }
    bubblePointerStart = false;
    return;
  }

  pointerStart = null;
  windowStart = null;
  isDragging = false;

  if (petStage?.hasPointerCapture(event.pointerId)) {
    petStage.releasePointerCapture(event.pointerId);
  }

  updateMousePassthrough(event);
});

petStage?.addEventListener("pointercancel", () => {
  pointerStart = null;
  windowStart = null;
  isDragging = false;
  bubblePointerStart = false;
});

window.addEventListener("pointerup", stopDragLift);
window.addEventListener("blur", () => {
  // On Windows, startDragging() immediately triggers blur. Skip stopping
  // the drag-lift animation so it stays visible during the native drag.
  if (!isNativeDragging) stopDragLift();
});
window.addEventListener("focus", () => {
  if (isNativeDragging) {
    isNativeDragging = false;
    stopDragLift();
  }
});

petImage?.addEventListener("load", refreshMousePassthrough);
window.addEventListener("load", refreshMousePassthrough);
