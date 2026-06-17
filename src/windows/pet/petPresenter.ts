// 单只 pet 的窗口呈现器（多窗口拆分后，每个 webview 只渲染一只 pet）。
//
// 由自己窗口（label "main"）与每个远程 pet 窗口（label "pet-<userId>"）共用：
// 负责动画→图像、像素命中、鼠标穿透、气泡纵向布局/翻转、拖动（原生+手动）与拖起动画。
// 不碰 Supabase，也不知道「房间/成员」——数据由各自入口（self entry / 协调者事件）喂进来。
//
// 每个窗口是独立 document，故 messageBubble / 命中等「文档级」助手天然只作用于本窗口这一只 pet。
import type { PetAnimator } from "./petState.js";
import { isPointOpaqueInImage } from "./hitTesting.js";
import { applyStateToImage } from "./renderImage.js";
import { startNativeWindowDragWithLift } from "./petDrag.js";
import {
  PET_WINDOW_HEIGHT,
  getBubbleWindowLayout,
  computeWindowTop,
  petAnchorBottomY,
  shouldFlipStack,
} from "./petLayout.js";
import {
  initBubbleStacks,
  mountStack,
  setMessagesForArea,
  addMessageToArea,
  showArea,
  hasMessagesForArea,
  hasVisibleBubbles,
} from "./messageBubble.js";
import type { LocalMessage, WindowPoint } from "../../types";

type HoverEventLike = { clientX: number; clientY: number; target: EventTarget | null };
type PointerPoint = { x: number; y: number };

export type PetPresenter = {
  animator: PetAnimator;
  applyWindowLayout: (reason?: string) => Promise<void>;
  refreshPassthrough: () => void;
  setMessages: (messages: LocalMessage[]) => void;
  addMessage: (message: LocalMessage) => void;
  showBubble: () => void;
  hasMessages: () => boolean;
};

export type PetPresenterOptions = {
  stage: HTMLElement;
  area: HTMLElement;
  petImage: HTMLImageElement;
  animator: PetAnimator;
  getScale: () => number;
  /** 本窗口的 pet 是否可被拖动（自己永远可拖；远程仅在「完全自由」模式可拖）。 */
  isDraggable: () => boolean;
  /** 右键菜单（自己菜单 vs 远程菜单由调用方决定）。 */
  onShowContextMenu: (event: MouseEvent) => void | Promise<void>;
  /** 真正发生过一次拖动后回调，附带窗口新左上角（自己→持久化+重排；远程→上报协调者）。 */
  onDragEnded?: (pos: WindowPoint) => void;
  /** 记号棒（输入条）是否展开——仅自己窗口有，用于把其纳入气泡纵向空间与命中。 */
  hasComposeOpen?: () => boolean;
};

const BUBBLE_REGION_SELECTOR = ".bubble-stack:not([hidden]), .compose-stick:not([hidden])";
const ALPHA_HIT_THRESHOLD = 16;
const ALPHA_HIT_SLOP = 3;

export function createPetPresenter(opts: PetPresenterOptions): PetPresenter {
  const { stage, area, petImage, animator } = opts;
  const hasComposeOpen = opts.hasComposeOpen ?? (() => false);

  const hitCanvas = document.createElement("canvas");
  const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
  const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

  let pointerStart: PointerPoint | null = null;
  let windowStart: WindowPoint | null = null;
  let isDragging = false;
  let isIgnoringMouseEvents = false;
  let lastPointerEvent: HoverEventLike | null = null;
  let dragLiftTimer: ReturnType<typeof setTimeout> | null = null;
  let isNativeDragging = false;

  let currentLayout = { height: Math.round(PET_WINDOW_HEIGHT * opts.getScale()), belowWin: 0 };
  let layoutPending = false;
  let layoutQueued = false;
  let layoutSeq = 0;

  animator.onState = (_state, path, meta) => applyStateToImage(petImage, path, meta, refreshPassthrough);

  // ── Window layout (single pet vertical grow + edge-aware flip) ──────────
  async function applyWindowLayout(reason = "?"): Promise<void> {
    if (layoutPending) {
      layoutQueued = true;
      return;
    }
    layoutPending = true;
    const seq = ++layoutSeq;
    try {
      const hasBubbles = hasVisibleBubbles() || hasComposeOpen();
      const scale = opts.getScale();
      const pos = await window.goodPuppy.getWindowPosition();
      const anchor = petAnchorBottomY(pos.y, currentLayout);

      let flipped = false;
      if (hasBubbles) {
        const work = await window.goodPuppy.getMonitorWorkArea();
        flipped = shouldFlipStack({ anchorBottomY: anchor, scale, workAreaTop: work.y });
      }

      const layout = getBubbleWindowLayout({ scale, hasBubbles, flipped });
      const top = computeWindowTop(anchor, layout);

      document.documentElement.style.setProperty("--stack-below", `${layout.belowWin}px`);
      stage.classList.toggle("is-flipped", flipped);

      window.goodPuppy.setWindowBounds({ x: pos.x, y: top, width: layout.width, height: layout.height });
      currentLayout = { height: layout.height, belowWin: layout.belowWin };
      refreshPassthrough();
      void seq;
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

  // ── Hit testing & mouse passthrough ────────────────────────────────────
  function closestFromEvent<T extends Element>(event: { target: EventTarget | null }, selector: string) {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest(selector) as T | null;
  }

  function isPetOpaqueAt(event: HoverEventLike) {
    const image = closestFromEvent<HTMLImageElement>(event, ".pet-image");
    if (!image) return false;
    if (!image.complete) {
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
      alphaThreshold: ALPHA_HIT_THRESHOLD,
      hitSlop: ALPHA_HIT_SLOP,
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

  function updateBubbleHover(event: HoverEventLike) {
    const stack = area.querySelector<HTMLElement>(".bubble-stack:not([hidden])");
    const hovered = Boolean(stack) && isPointInsideElement(event, stack!);
    area.classList.toggle("bubble-hovered", hovered);
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

  function refreshPassthrough() {
    if (lastPointerEvent) {
      const event = lastPointerEvent;
      window.requestAnimationFrame(() => updateMousePassthrough(event));
    }
  }

  // ── Drag-lift ──────────────────────────────────────────────────────────
  function startDragLift() {
    animator.setHeld("drag-lift");
    if (dragLiftTimer != null) clearTimeout(dragLiftTimer);
    dragLiftTimer = setTimeout(stopDragLift, 4000);
  }

  function stopDragLift() {
    if (dragLiftTimer != null) {
      clearTimeout(dragLiftTimer);
      dragLiftTimer = null;
    }
    animator.setHeld(null);
  }

  function targetElement(target: EventTarget | null) {
    return target instanceof Element ? target : null;
  }

  async function reportDragEnded() {
    await applyWindowLayout("drag-ended");
    if (opts.onDragEnded) {
      const pos = await window.goodPuppy.getWindowPosition();
      opts.onDragEnded(pos);
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  initBubbleStacks({
    onRefreshPassthrough: refreshPassthrough,
    onVisibilityChange: () => void applyWindowLayout("bubble-visibility"),
  });
  mountStack(area);

  document.addEventListener("mousemove", updateMousePassthrough);
  document.addEventListener("mouseleave", () => {
    if (!pointerStart) setMousePassthrough(true);
  });

  window.goodPuppy.onCursorMoved((point) => {
    if (!point) return;
    const target = document.elementFromPoint(point.x, point.y) || document.body;
    updateMousePassthrough({ clientX: point.x, clientY: point.y, target });
  });

  stage.addEventListener("pointerdown", async (event: PointerEvent) => {
    setMousePassthrough(false);
    if (event.button !== 0) return;
    if (
      targetElement(event.target)?.closest(".bubble-stack") ||
      targetElement(event.target)?.closest(".compose-stick")
    )
      return;
    if (!isPetOpaqueAt(event)) return;
    if (!opts.isDraggable()) return;

    if (supportsNativeWindowDrag) {
      startNativeWindowDragWithLift({
        isSelfPet: true,
        setNativeDragging: (next) => {
          isNativeDragging = next;
        },
        startWindowDrag: () => window.goodPuppy.startWindowDrag(),
        startDragLift,
      });
      return;
    }

    startDragLift();
    pointerStart = { x: event.screenX, y: event.screenY };
    isDragging = false;
    stage.setPointerCapture(event.pointerId);
    windowStart = await window.goodPuppy.getWindowPosition();
  });

  stage.addEventListener("contextmenu", (event: MouseEvent) => {
    if (
      targetElement(event.target)?.closest(".bubble-stack") ||
      targetElement(event.target)?.closest(".compose-stick")
    )
      return;
    event.preventDefault();
    if (!isPetOpaqueAt(event)) return;
    void opts.onShowContextMenu(event);
  });

  stage.addEventListener("pointermove", (event: PointerEvent) => {
    updateMousePassthrough(event);
    if (!pointerStart) return;
    const deltaX = event.screenX - pointerStart.x;
    const deltaY = event.screenY - pointerStart.y;
    isDragging = true;
    if (windowStart) {
      window.goodPuppy.setWindowPosition({ x: windowStart.x + deltaX, y: windowStart.y + deltaY });
    }
  });

  stage.addEventListener("pointerup", (event: PointerEvent) => {
    const dragged = isDragging;
    pointerStart = null;
    windowStart = null;
    isDragging = false;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    updateMousePassthrough(event);
    if (dragged) void reportDragEnded();
  });

  stage.addEventListener("pointercancel", () => {
    pointerStart = null;
    windowStart = null;
    isDragging = false;
  });

  window.addEventListener("pointerup", stopDragLift);
  window.addEventListener("blur", () => {
    if (!isNativeDragging) stopDragLift();
  });
  window.goodPuppy.onDragEnded(() => {
    const wasNative = isNativeDragging;
    isNativeDragging = false;
    stopDragLift();
    // 原生拖动结束：重排并上报新位置。手动拖动已在 pointerup 处理，避免重复上报。
    if (wasNative) void reportDragEnded();
    else void applyWindowLayout("drag-ended");
  });

  petImage.addEventListener("load", refreshPassthrough);
  window.addEventListener("load", refreshPassthrough);

  return {
    animator,
    applyWindowLayout,
    refreshPassthrough,
    setMessages: (messages) => setMessagesForArea(area, messages),
    addMessage: (message) => addMessageToArea(area, message),
    showBubble: () => showArea(area),
    hasMessages: () => hasMessagesForArea(area),
  };
}
