// pet 窗口固定 pet 尺寸：pet-image 占 dog-area 底部 14..114px，再留 6px 顶部余量。
// 多窗口 Phase A 后气泡 / 记号棒住在独立气泡窗口，不再在 pet 窗口内增高承接。
export const PET_WINDOW_HEIGHT = 120;
export const BASE_PET_WINDOW_WIDTH = 150;

/** 独立气泡窗口为堆叠预留的纵向空间（CSS px，会随 --pet-scale 缩放）。
   约等于 3 条气泡高度，再多靠滚动。 */
export const BUBBLE_STACK_SPACE = 180;

/** 独立气泡窗口的基础尺寸（多窗口 Phase A）。宽度对齐 pet 窗口以居中于宠物头顶，
 * 高度容纳约 3 条气泡堆叠（再多靠滚动）。随 --pet-scale 缩放。 */
export function getBubbleWindowSize(scale = DEFAULT_PET_SCALE) {
  const s = clampPetScale(scale);
  return {
    width: Math.round(BASE_PET_WINDOW_WIDTH * s),
    height: Math.round(BUBBLE_STACK_SPACE * s),
  };
}

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

export type BubblePlacement = "above" | "below";

type Rect = { x: number; y: number; width: number; height: number };

/**
 * 计算独立气泡窗口的左上角位置与上/下朝向（多窗口 Phase A，纯函数）。
 *
 * - 默认摆在 pet 窗口正上方（气泡底边贴 pet 顶边）；上方空间不足（会越过可用区顶部，
 *   如 macOS 菜单栏）时翻到下方（气泡顶边贴 pet 底边）。
 * - 水平方向气泡与 pet 居中对齐，并夹在可用区内，避免飞出屏幕边缘。
 *
 * 退役了 Phase B「撑高窗口 + 反锚点补偿」那套（`getBubbleWindowLayout` /
 * `computeWindowTop` / `shouldFlipStack`）——气泡是独立窗口，只需算它自己的位置。
 */
export function computeBubbleWindowPosition(opts: {
  pet: Rect;
  bubble: { width: number; height: number };
  workArea: Rect;
}): { x: number; y: number; placement: BubblePlacement } {
  const { pet, bubble, workArea } = opts;
  const aboveY = pet.y - bubble.height;
  const placement: BubblePlacement = aboveY >= workArea.y ? "above" : "below";
  const y = placement === "above" ? aboveY : pet.y + pet.height;

  const centeredX = pet.x + (pet.width - bubble.width) / 2;
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - bubble.width;
  const x = Math.min(Math.max(centeredX, minX), Math.max(minX, maxX));

  return { x: Math.round(x), y: Math.round(y), placement };
}
