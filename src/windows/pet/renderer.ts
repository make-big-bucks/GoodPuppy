import { PetAnimator } from "./petState.js";
import { loadPetManifest, DEFAULT_SKIN } from "./animationCatalog.js";
import { isPointOpaqueInImage } from "./hitTesting.js";
import { applyStateToImage } from "./renderImage.js";
import { startNativeWindowDragWithLift } from "./petDrag.js";
import * as presence from "./presence.js";
import {
  clampPetScale,
  stepPetScale,
  DEFAULT_PET_SCALE,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
  PET_WINDOW_HEIGHT,
  getBubbleWindowLayout,
  computeWindowTop,
  petAnchorBottomY,
  shouldFlipStack,
} from "./petLayout.js";
import { readStoredSkin, writeStoredSkin, readStoredScale, writeStoredScale } from "./preferences.js";
import {
  initBubbleStacks,
  mountStack,
  setMessagesForArea,
  addMessageToArea,
  showArea,
  hasMessagesForArea,
  hasVisibleBubbles,
} from "./messageBubble.js";
import { initComposeStick, openComposeStick, isComposeOpen, getComposeStickElement } from "./composeStick.js";
import {
  initRemotePets,
  applyPresence,
  clearRemotePets,
  relayoutRemotePets,
  getPetIdentityForEvent,
  getRemotePetArea,
  getRemotePetCount,
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
import type { LocalMessage, PetStatus, WindowPoint } from "../../types";

export { startPetApp, switchRoom, getCurrentRoomId, exitCurrentRoom };

let _onRoomReadyCb: (() => void) | null = null;
export function setOnRoomReadyCallback(fn: () => void) {
  _onRoomReadyCb = fn;
}

type PointerPoint = { x: number; y: number };
type HoverEventLike = { clientX: number; clientY: number; target: EventTarget | null };

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const alphaHitThreshold = 16;
const alphaHitSlop = 3;
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

const petImage = document.querySelector<HTMLImageElement>('.pet-image[data-user="self"]');
const selfArea = document.querySelector<HTMLElement>('.dog-area[data-user="self"]');
const selfComposeStick = document.querySelector<HTMLElement>('.compose-stick[data-user="self"]');

let selfPetId = "default";
let selfSkin = readStoredSkin();
let petScale = readStoredScale();

let pointerStart: PointerPoint | null = null;
let windowStart: WindowPoint | null = null;
let isDragging = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent: HoverEventLike | null = null;
let dragLiftTimer: ReturnType<typeof setTimeout> | null = null;
let isNativeDragging = false;

// 上一次应用的窗口纵向布局，用于反推宠物锚点（保证增高/翻转时宠物视觉不动）。
let currentLayout = { height: Math.round(PET_WINDOW_HEIGHT * petScale), belowWin: 0 };
let layoutPending = false;
let layoutQueued = false;

// 房间最近消息缓存：远程宠物晚于消息加载时入场，可据此补齐其头上堆叠。
let roomMessageCache: LocalMessage[] = [];
const ROOM_CACHE_LIMIT = 200;

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
  onState: (_state, path, meta) => applyStateToImage(petImage, path, meta, refreshMousePassthrough),
});

loadPetManifest(selfPetId).then((manifest) => {
  selfAnimator.setManifest(manifest);
  selfAnimator.playTransient("enter");
});

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

// ── Message routing ───────────────────────────────────────────

function cacheMessage(msg: LocalMessage) {
  if (roomMessageCache.some((m) => m.id === msg.id)) return;
  roomMessageCache.push(msg);
  if (roomMessageCache.length > ROOM_CACHE_LIMIT) {
    roomMessageCache = roomMessageCache.slice(roomMessageCache.length - ROOM_CACHE_LIMIT);
  }
}

function areaForSender(senderId: string): HTMLElement | null {
  if (senderId === getSelfAuthId()) return selfArea;
  return getRemotePetArea(senderId);
}

/** 路由单条消息到对应宠物头上的堆叠（发送者未在房间渲染时忽略）。 */
function routeMessage(msg: LocalMessage) {
  cacheMessage(msg);
  const area = areaForSender(msg.from);
  if (area) addMessageToArea(area, msg);
}

/** 房间历史载入：缓存全部，并按发送者分组渲染到各宠物堆叠。 */
function loadRoomMessages(messages: LocalMessage[]) {
  roomMessageCache = messages.slice(-ROOM_CACHE_LIMIT);
  const bySender = new Map<string, LocalMessage[]>();
  for (const m of messages) {
    const list = bySender.get(m.from) ?? [];
    list.push(m);
    bySender.set(m.from, list);
  }
  for (const [sender, list] of bySender) {
    const area = areaForSender(sender);
    if (area) setMessagesForArea(area, list);
  }
}

// ── Window layout (dynamic height + edge-aware flip) ──────────

/**
 * 统一编排宠物窗口尺寸：水平随宠物数量、纵向随气泡有无增高，顶部空间不足时翻转，
 * 并补偿窗口位置使宠物视觉位置保持不变。串行化以避免并发的尺寸/位置竞争。
 */
let layoutSeq = 0;
async function applyWindowLayout(reason = "?") {
  if (layoutPending) {
    layoutQueued = true;
    console.log(`[layout] coalesced (busy) reason=${reason}`);
    return;
  }
  layoutPending = true;
  const seq = ++layoutSeq;
  try {
    const hasBubbles = hasVisibleBubbles() || isComposeOpen();
    const scale = petScale;
    const pos = await window.goodPuppy.getWindowPosition();
    const anchor = petAnchorBottomY(pos.y, currentLayout);

    let flipped = false;
    let workTop: number | null = null;
    if (hasBubbles) {
      const work = await window.goodPuppy.getMonitorWorkArea();
      workTop = work.y;
      flipped = shouldFlipStack({ anchorBottomY: anchor, scale, workAreaTop: work.y });
    }

    const layout = getBubbleWindowLayout({
      remotePetCount: getRemotePetCount(),
      scale,
      hasBubbles,
      flipped,
    });
    const top = computeWindowTop(anchor, layout);

    console.log(
      `[layout] #${seq} reason=${reason} ` +
        JSON.stringify({
          hasBubbles,
          scale,
          posY: pos.y,
          curH: currentLayout.height,
          curBelow: currentLayout.belowWin,
          anchor,
          workTop,
          flipped,
          newTop: top,
          newH: layout.height,
          newBelow: layout.belowWin,
        }),
    );

    document.documentElement.style.setProperty("--stack-below", `${layout.belowWin}px`);
    petStage?.classList.toggle("is-flipped", flipped);

    window.goodPuppy.setWindowBounds({ x: pos.x, y: top, width: layout.width, height: layout.height });
    currentLayout = { height: layout.height, belowWin: layout.belowWin };
    refreshMousePassthrough();

    // DIAGNOSTIC: read back where the window actually came to rest, twice, to
    // catch the OS clamping/moving it after we set the bounds (which would show
    // as a flash). wanted == settled means our set stuck.
    const wantedTop = top;
    requestAnimationFrame(async () => {
      const s1 = await window.goodPuppy.getWindowPosition();
      requestAnimationFrame(async () => {
        const s2 = await window.goodPuppy.getWindowPosition();
        console.log(`[layout] #${seq} settled posY: wanted=${wantedTop} frame1=${s1.y} frame2=${s2.y}`);
      });
    });
  } catch (error) {
    console.error("applyWindowLayout failed:", error);
  } finally {
    layoutPending = false;
    if (layoutQueued) {
      layoutQueued = false;
      void applyWindowLayout("queued");
    }
  }
}

// ── Module initialization ─────────────────────────────────────

initBubbleStacks({
  onRefreshPassthrough: refreshMousePassthrough,
  onVisibilityChange: () => {
    void applyWindowLayout("bubble-visibility");
  },
});

if (petStage && selfArea) {
  mountStack(selfArea);
  initRemotePets({
    stage: petStage,
    selfArea,
    getPetScale: () => petScale,
    onRefreshPassthrough: refreshMousePassthrough,
    onSelfGreet: () => selfAnimator.playTransient("greet"),
    onRelayout: () => {
      void applyWindowLayout("remote-relayout");
    },
    onRemotePetCreated: (userId, area) => {
      setMessagesForArea(
        area,
        roomMessageCache.filter((m) => m.from === userId),
      );
    },
  });
}

initPetInteractions({
  getSelfAuthId: () => getSelfAuthId(),
  getSelfAnimator: () => selfAnimator,
});

if (selfComposeStick) {
  initComposeStick(selfComposeStick, {
    onRefreshPassthrough: refreshMousePassthrough,
    onVisibilityChange: () => {
      void applyWindowLayout("compose-visibility");
    },
    onSubmitMessage: async (info) => {
      const supabase = getActiveSupabase();
      const authId = getSelfAuthId();
      const roomId = getCurrentRoomId();
      if (!supabase || !authId || !roomId) throw new Error("请先登录");
      const { data, error } = await supabase.from("messages").insert({
        room_id: roomId,
        sender_id: authId,
        kind: "text",
        content: info,
      }).select("id, created_at").single();
      if (error) throw error;
      selfAnimator.playTransient("message");
      // 用数据库返回的真实 ID 立即路由，realtime 事件抵达时 insertMessage 按 ID 去重，避免重复。
      routeMessage({ id: data.id, info, from: authId, created_at: data.created_at });
    },
  });
}

initRoomManager({
  onPresenceChange: applyPresence,
  onInteraction: applyInteraction,
  onMessagesLoaded: (messages) => loadRoomMessages(messages),
  onNewMessage: (msg) => routeMessage(msg),
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
  if (!image.complete) {
    // Image is transitioning to a new state; fall back to element bounds so
    // the first click after a state change still registers as a hit.
    const rect = image.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }
  return isPointOpaqueInImage(event, image, image, hitContext, hitCanvas, {
    respectObjectFit: true,
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

const BUBBLE_REGION_SELECTOR = ".bubble-stack:not([hidden]), .compose-stick:not([hidden])";

/** 命中任一可见气泡堆叠 / 记号棒区域（代码绘制气泡用矩形包围盒，不再按图 alpha 采样）。 */
function isBubbleRegionAt(event: HoverEventLike) {
  return [...document.querySelectorAll<HTMLElement>(BUBBLE_REGION_SELECTOR)].some((region) =>
    isPointInsideElement(event, region),
  );
}

function isInteractiveAt(event: HoverEventLike) {
  if (isBubbleRegionAt(event)) return true;
  return isPetOpaqueAt(event);
}

function setMousePassthrough(shouldPassThrough: boolean) {
  if (isIgnoringMouseEvents === shouldPassThrough) return;
  isIgnoringMouseEvents = shouldPassThrough;
  window.goodPuppy.setIgnoreMouseEvents(shouldPassThrough);
}

/** 光标落在某只宠物气泡区时给其 .dog-area 加 .bubble-hovered，控制关闭按钮显隐。
 * 由全局光标采样（onCursorMoved）驱动，故窗口未聚焦时悬浮也能浮现。 */
function updateBubbleHover(event: HoverEventLike) {
  document.querySelectorAll<HTMLElement>(".dog-area").forEach((area) => {
    const stack = area.querySelector<HTMLElement>(".bubble-stack:not([hidden])");
    const hovered = Boolean(stack) && isPointInsideElement(event, stack!);
    area.classList.toggle("bubble-hovered", hovered);
  });
}

function updateMousePassthrough(event: HoverEventLike) {
  lastPointerEvent = event;
  updateBubbleHover(event);
  if (pointerStart) {
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
  if (!pointerStart) setMousePassthrough(true);
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
    hasMessages: selfArea ? hasMessagesForArea(selfArea) : false,
    onShowMessage: () => {
      if (selfArea) showArea(selfArea);
    },
    onWriteMessage: openComposeStick,
    onSetStatus: setSelfStatus,
    onSetSkin: setSelfSkin,
    onSetScale: setPetScale,
  });

  // The "写消息" action fires inside the native menu's nested event loop; the
  // menu teardown resigns the panel's key status right after. Re-assert key +
  // input focus on the next frame, once the menu has fully dismissed, so the
  // compose textarea can actually receive keystrokes.
  if (isComposeOpen()) {
    requestAnimationFrame(() => {
      void window.goodPuppy.setFocus("post-menu-raf");
      getComposeStickElement()
        ?.querySelector<HTMLTextAreaElement>(".compose-input")
        ?.focus();
    });
  }
}

petStage?.addEventListener("pointerdown", async (event: PointerEvent) => {
  setMousePassthrough(false);
  if (event.button !== 0) return;
  // 气泡堆叠 / 记号棒区域：交给其内部控件与滚动，不触发窗口拖拽。
  if (
    targetElement(event.target)?.closest(".bubble-stack") ||
    targetElement(event.target)?.closest(".compose-stick")
  )
    return;

  if (!isPetOpaqueAt(event)) return;

  const isSelfPet = getPetIdentityForEvent(event).kind === "self";

  if (supportsNativeWindowDrag) {
    startNativeWindowDragWithLift({
      isSelfPet,
      setNativeDragging: (next) => {
        isNativeDragging = next;
      },
      startWindowDrag: () => window.goodPuppy.startWindowDrag(),
      startDragLift,
    });
    return;
  }

  if (isSelfPet) startDragLift();

  pointerStart = { x: event.screenX, y: event.screenY };
  isDragging = false;
  petStage?.setPointerCapture(event.pointerId);
  windowStart = await window.goodPuppy.getWindowPosition();
});

petStage?.addEventListener("contextmenu", (event: MouseEvent) => {
  if (
    targetElement(event.target)?.closest(".bubble-stack") ||
    targetElement(event.target)?.closest(".compose-stick")
  )
    return;
  event.preventDefault();
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
  const dragged = isDragging;
  pointerStart = null;
  windowStart = null;
  isDragging = false;

  if (petStage?.hasPointerCapture(event.pointerId)) {
    petStage.releasePointerCapture(event.pointerId);
  }

  updateMousePassthrough(event);
  // 仅在确实拖动过时重算：窗口可能已贴近屏幕顶部，按需翻转气泡 / 输入条。
  if (dragged) void applyWindowLayout("drag-ended");
});

petStage?.addEventListener("pointercancel", () => {
  pointerStart = null;
  windowStart = null;
  isDragging = false;
});

window.addEventListener("pointerup", stopDragLift);
window.addEventListener("blur", () => {
  // On Windows, startDragging() enters an OS modal move loop that fires a
  // blur→focus bounce at drag *start*. Skip stopping during a native drag so
  // the lift survives; the drag-end signal below ends it on actual release.
  if (!isNativeDragging) stopDragLift();
});
// Native drags swallow pointerup (Windows especially), so end the lift on the
// real mouse-button release reported by the Rust cursor monitor.
window.goodPuppy.onDragEnded(() => {
  isNativeDragging = false;
  stopDragLift();
  // 拖动后窗口可能已贴近屏幕顶部，重算布局以按需翻转气泡 / 输入条。
  void applyWindowLayout("drag-ended");
});

petImage?.addEventListener("load", refreshMousePassthrough);
window.addEventListener("load", refreshMousePassthrough);
