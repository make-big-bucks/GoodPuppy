// 单只 pet 的窗口呈现器（多窗口拆分后，每个 webview 只渲染一只 pet）。
//
// 由自己窗口（label "main"）与每个远程 pet 窗口（label "pet-<userId>"）共用：
// 负责动画→图像、像素命中、拖动（原生+手动）与拖起动画。窗口固定 pet 尺寸——
// 气泡 / 记号棒已搬进独立气泡窗口（bubble.html / bubbleMain），不再在 pet 窗口内增高翻转。
// 不碰 Supabase，也不知道「房间/成员」——数据由各自入口（self entry / 协调者事件）喂进来。
//
// 鼠标穿透由原生侧独占：本呈现器只在「可交互形状变化时」把命中形状（pet 剪影掩模 +
// 拖动强制位）下发给原生（见 publishHitShape / Rust 光标监视器），原生每个轮询 tick 直接
// 判定 setIgnoreCursorEvents——免去逐帧 IPC 往返与「进入 pet 才慢慢变可交互」的延迟。
import type { PetAnimator } from "./petState.js";
import { isPointOpaqueInImage, buildAlphaMask } from "./hitTesting.js";
import { applyStateToImage } from "./renderImage.js";
import { startNativeWindowDragWithLift } from "./petDrag.js";
import type { WindowPoint } from "../../types";

type HoverEventLike = { clientX: number; clientY: number; target: EventTarget | null };
type PointerPoint = { x: number; y: number };

export type PetPresenter = {
  animator: PetAnimator;
  /** 重新计算并下发本窗口的可交互命中形状（名字沿用历史语义：刷新穿透判定）。 */
  refreshPassthrough: () => void;
};

export type PetPresenterOptions = {
  stage: HTMLElement;
  petImage: HTMLImageElement;
  animator: PetAnimator;
  /** 本窗口的 pet 是否可被拖动（自己永远可拖；远程仅在「完全自由」模式可拖）。 */
  isDraggable: () => boolean;
  /** 右键菜单（自己菜单 vs 远程菜单由调用方决定）。 */
  onShowContextMenu: (event: MouseEvent) => void | Promise<void>;
  /** 真正发生过一次拖动后回调，附带窗口新左上角（自己→持久化+重排；远程→上报协调者）。 */
  onDragEnded?: (pos: WindowPoint) => void;
};

const ALPHA_HIT_THRESHOLD = 16;
const ALPHA_HIT_SLOP = 3;
// 周期性重发命中形状：让掩模跟上 GIF 自播放的剪影变化（结构性变化另有即时触发）。
const HIT_SHAPE_REFRESH_MS = 120;

export function createPetPresenter(opts: PetPresenterOptions): PetPresenter {
  const { stage, petImage, animator } = opts;

  const hitCanvas = document.createElement("canvas");
  const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
  const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

  let pointerStart: PointerPoint | null = null;
  let windowStart: WindowPoint | null = null;
  let isDragging = false;
  let dragLiftTimer: ReturnType<typeof setTimeout> | null = null;
  let isNativeDragging = false;
  // 拖动期间整窗强制可交互：即便光标短暂滑出 pet 剪影也不被原生翻成穿透。
  let forceInteractive = false;

  animator.onState = (_state, path, meta) => applyStateToImage(petImage, path, meta, refreshPassthrough);

  // ── Hit testing helpers ─────────────────────────────────────────────────
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

  // ── Native passthrough via published hit shape ──────────────────────────
  // pet 窗口只剩 pet 剪影一个可交互区域（气泡在独立窗口自管命中），故无额外矩形。
  function publishHitShape() {
    const maskData = buildAlphaMask(petImage, petImage, hitContext, hitCanvas, {
      respectObjectFit: true,
      alphaThreshold: ALPHA_HIT_THRESHOLD,
    });
    window.goodPuppy.publishHitShape({
      mask: maskData?.mask ?? [],
      maskCols: maskData?.maskCols ?? 0,
      maskRows: maskData?.maskRows ?? 0,
      maskRect: maskData?.maskRect ?? [0, 0, 0, 0],
      rects: [],
      forceInteractive,
    });
  }

  // 合并一帧内的多次触发（动画帧 + 图片 load 常同时发生）。
  let publishScheduled = false;
  function refreshPassthrough() {
    if (publishScheduled) return;
    publishScheduled = true;
    window.requestAnimationFrame(() => {
      publishScheduled = false;
      publishHitShape();
    });
  }

  function setForceInteractive(next: boolean) {
    if (forceInteractive === next) return;
    forceInteractive = next;
    refreshPassthrough();
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

  async function reportDragEnded() {
    if (opts.onDragEnded) {
      const pos = await window.goodPuppy.getWindowPosition();
      opts.onDragEnded(pos);
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  stage.addEventListener("pointerdown", async (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (!isPetOpaqueAt(event)) return;
    if (!opts.isDraggable()) return;

    // 拖动期间保持整窗可交互，避免光标滑出剪影时原生把窗口翻成穿透中断拖动。
    setForceInteractive(true);

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
    event.preventDefault();
    if (!isPetOpaqueAt(event)) return;
    void opts.onShowContextMenu(event);
  });

  stage.addEventListener("pointermove", (event: PointerEvent) => {
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
    // 原生拖动由 onDragEnded 收尾（pointerup 可能被系统 modal loop 吞掉）。
    if (!isNativeDragging) setForceInteractive(false);
    if (dragged) void reportDragEnded();
  });

  stage.addEventListener("pointercancel", () => {
    pointerStart = null;
    windowStart = null;
    isDragging = false;
    if (!isNativeDragging) setForceInteractive(false);
  });

  window.addEventListener("pointerup", stopDragLift);
  window.addEventListener("blur", () => {
    if (!isNativeDragging) stopDragLift();
  });
  window.goodPuppy.onDragEnded(() => {
    const wasNative = isNativeDragging;
    isNativeDragging = false;
    setForceInteractive(false);
    stopDragLift();
    // 原生拖动结束：上报新位置。手动拖动已在 pointerup 处理，避免重复上报。
    if (wasNative) void reportDragEnded();
  });

  petImage.addEventListener("load", refreshPassthrough);
  window.addEventListener("load", refreshPassthrough);
  window.addEventListener("resize", refreshPassthrough);

  // 周期性重发掩模，跟上 GIF 自播放的剪影；隐藏时跳过以省电。
  window.setInterval(() => {
    if (document.visibilityState === "visible") refreshPassthrough();
  }, HIT_SHAPE_REFRESH_MS);

  // 首帧即下发一次，让 pet 一出现就可交互。
  refreshPassthrough();

  return {
    animator,
    refreshPassthrough,
  };
}
