// 仅容纳宠物动画本身的窗口高度：pet-image 占 dog-area 底部 14..114px，
// 再留 6px 顶部余量。气泡 / 记号棒所需的纵向空间在有内容时由 getBubbleWindowLayout
// 额外增高承接（见本文件与 renderer.ts）。
export const PET_WINDOW_HEIGHT = 120;
export const BASE_PET_WINDOW_WIDTH = 150;

/** 气泡堆叠在宠物上方/下方预留的纵向空间（CSS px，会随 --pet-scale 缩放）。
   约等于 3 条气泡高度，再多靠滚动。见 docs/superpowers/specs/2026-06-15-...。 */
export const BUBBLE_STACK_SPACE = 180;

export const DEFAULT_PET_SCALE = 1;
export const MIN_PET_SCALE = 0.6;
export const MAX_PET_SCALE = 2;
export const PET_SCALE_STEP = 0.2;

export function orderRemotePetIds(userIds: string[] = []) {
  return [...new Set(userIds.filter(Boolean))].sort();
}

export function clampPetScale(scale: number | string | null | undefined) {
  const n = Number(scale);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PET_SCALE;
  const clamped = Math.min(MAX_PET_SCALE, Math.max(MIN_PET_SCALE, n));
  return Math.round(clamped * 100) / 100;
}

export function stepPetScale(scale: number | string | null | undefined, direction: number) {
  return clampPetScale(clampPetScale(scale) + Math.sign(direction) * PET_SCALE_STEP);
}

/** 单只 pet 窗口的基础尺寸（无气泡时），随 --pet-scale 缩放。
 * 多窗口拆分后，每个窗口只容纳一只 pet，不再随成员数横向撑宽。 */
export function getPetWindowSize(scale = DEFAULT_PET_SCALE) {
  const s = clampPetScale(scale);
  return {
    width: Math.round(BASE_PET_WINDOW_WIDTH * s),
    height: Math.round(PET_WINDOW_HEIGHT * s),
  };
}

export type BubbleWindowLayout = {
  width: number;
  height: number;
  /** 宠物下方为翻转堆叠预留的窗口空间（window px）。宠物 dog-area 以此为 bottom 偏移。 */
  belowWin: number;
  /** 宠物上方为正常堆叠预留的窗口空间（window px）。 */
  aboveWin: number;
};

/**
 * 计算宠物窗口尺寸 + 纵向气泡空间。
 * - 无可见气泡时窗口仅容纳宠物本身（与旧行为一致）。
 * - 有气泡时在宠物上方（默认）或下方（翻转）增高一段堆叠空间。
 */
export function getBubbleWindowLayout(opts: {
  scale?: number;
  hasBubbles: boolean;
  flipped: boolean;
}): BubbleWindowLayout {
  const { hasBubbles, flipped } = opts;
  const s = clampPetScale(opts.scale ?? DEFAULT_PET_SCALE);
  const base = getPetWindowSize(s);
  const stack = hasBubbles ? Math.round(BUBBLE_STACK_SPACE * s) : 0;
  const belowWin = hasBubbles && flipped ? stack : 0;
  const aboveWin = stack - belowWin;
  return {
    width: base.width,
    height: base.height + stack,
    belowWin,
    aboveWin,
  };
}

/**
 * 给定宠物锚点（dog-area 底边的固定屏幕 Y）和新窗口布局，算出窗口左上角应放置的 Y，
 * 使宠物视觉位置在增高/缩回/翻转时保持不变。
 *
 * 窗口底边 = top + height；dog-area 底边 = 窗口底边 - belowWin = 锚点。
 * => top = anchorBottomY - height + belowWin。
 */
export function computeWindowTop(anchorBottomY: number, layout: BubbleWindowLayout): number {
  return Math.round(anchorBottomY - layout.height + layout.belowWin);
}

/**
 * 由当前真实窗口位置与上一次应用的布局，反推宠物锚点（dog-area 底边屏幕 Y）。
 * 锚点 = 当前窗口顶 + 当前窗口高 - 当前 belowWin。
 */
export function petAnchorBottomY(windowTopY: number, currentLayout: { height: number; belowWin: number }): number {
  return windowTopY + currentLayout.height - currentLayout.belowWin;
}

/**
 * 顶部空间不足时是否应把堆叠翻到宠物下方。
 * 不翻转时窗口顶 = 锚点 - (宠物高 + 堆叠空间) * scale；若其低于可用区顶部则翻转。
 */
export function shouldFlipStack(opts: {
  anchorBottomY: number;
  scale?: number;
  workAreaTop: number;
}): boolean {
  const s = clampPetScale(opts.scale ?? DEFAULT_PET_SCALE);
  const notFlippedTop = opts.anchorBottomY - (PET_WINDOW_HEIGHT + BUBBLE_STACK_SPACE) * s;
  return notFlippedTop < opts.workAreaTop;
}
